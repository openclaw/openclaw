import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GitHubIdentityController } from "../features/github-connections/github-identity-controller.ts";
import { renderGitHubConnectionSetup } from "../features/github-connections/github-identity-view.ts";
import { renderWorkspaceConflictNotice } from "../pages/chat/components/chat-workspace-conflict.ts";
import { renderDevicePairSetup } from "../pages/devices/view-pairing.runtime.ts";
import { renderSessionsCard } from "../pages/usage/view-overview.ts";
import { renderCopyButton } from "./copy-button.ts";
import { renderWizardStepControls } from "./wizard-step-controls.ts";

let owner: HTMLElement;
const writeText = vi.fn<(text: string) => Promise<void>>();
const fallback = vi.fn(() => true);
const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");

beforeEach(() => {
  vi.useFakeTimers();
  owner = document.body.appendChild(document.createElement("section"));
  writeText.mockReset().mockResolvedValue(undefined);
  fallback.mockClear();
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  Object.defineProperty(document, "execCommand", { configurable: true, value: fallback });
});

afterEach(() => {
  render(nothing, owner);
  owner.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (execCommandDescriptor) {
    Object.defineProperty(document, "execCommand", execCommandDescriptor);
  } else {
    Reflect.deleteProperty(document, "execCommand");
  }
});

const surfaces = [
  {
    name: "generic copy",
    view: (text: string) => renderCopyButton(text, "Copy text"),
    selector: ".chat-copy-btn",
  },
  {
    name: "wizard code",
    view: (text: string) =>
      renderWizardStepControls({
        step: {
          id: "sign-in",
          type: "progress",
          executor: "gateway",
          externalUrl: "https://example.com/device",
          deviceCode: { code: text },
        },
        value: undefined,
        busy: false,
        inputId: "wizard-input",
        onValueChange: vi.fn(),
        onAnswer: vi.fn(),
      }),
    selector: ".wizard-step__actions button",
  },
  {
    name: "device pairing code",
    view: (text: string) =>
      renderDevicePairSetup({
        open: true,
        lifecycle: {
          phase: "waiting",
          access: "full",
          setup: {
            setupId: "setup",
            setupCode: text,
            gatewayUrl: "wss://gateway.example",
            auth: "token",
            urlSource: "test",
            access: "full",
            expiresAtMs: 70_000,
          },
        },
        nowMs: 10_000,
        pendingCount: 0,
        onRefresh: vi.fn(),
        onAccessChange: vi.fn(),
        onClose: vi.fn(),
        onManageDevices: vi.fn(),
        onGetApps: vi.fn(),
      }),
    selector: ".device-pair-setup__actions button",
  },
  {
    name: "GitHub authorization code",
    view: (text: string) => {
      const controller = new GitHubIdentityController({ requestUpdate: vi.fn() });
      controller.statusReadable = controller.authorizable = true;
      vi.spyOn(controller, "connectionReady", "get").mockReturnValue(true);
      vi.spyOn(controller, "authorization", "get").mockReturnValue({
        phase: "code",
        requestId: "github-device-test",
        userCode: text,
        verificationUri: "https://github.com/login/device",
        expiresInMs: 60_000,
        pollAfterMs: 5_000,
        displayExpiresAtMs: 70_000,
      });
      return renderGitHubConnectionSetup(controller);
    },
    selector: ".github-device-code + button",
  },
  {
    name: "usage session label",
    view: (text: string) =>
      renderSessionsCard(
        [{ key: "session", label: text, usage: null }],
        [],
        [],
        true,
        "recent",
        "desc",
        [],
        "all",
        vi.fn(),
        vi.fn(),
        vi.fn(),
        vi.fn(),
        [],
        1,
        vi.fn(),
      ),
    selector: ".session-bar-actions button",
  },
  {
    name: "workspace conflict command",
    view: (text: string) =>
      renderWorkspaceConflictNotice({
        conflict: { paths: [text], stagedResultRef: "refs/openclaw/worker-results/test" },
      }),
    selector: ".chat-workspace-conflict-path-actions button",
  },
];

describe("copy payload lifetime", () => {
  it.each(surfaces)("retires pending $name copying when its payload changes", async (surface) => {
    const pending = createDeferred();
    writeText.mockReturnValueOnce(pending.promise);
    render(surface.view("first"), owner);
    const button = owner.querySelector<HTMLButtonElement>(surface.selector)!;
    button.click();
    expect(writeText).toHaveBeenCalledOnce();
    render(surface.view("second"), owner);
    const current = owner.querySelector<HTMLButtonElement>(surface.selector)!;
    const availableBeforeSettlement = !current.disabled;
    pending.reject(new Error("Synthetic clipboard rejection"));
    await vi.advanceTimersByTimeAsync(0);

    expect(fallback).not.toHaveBeenCalled();
    expect(availableBeforeSettlement).toBe(true);
    expect(current.dataset.copyState).toBeUndefined();
    current.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText.mock.lastCall?.[0]).toContain("second");
    expect(current.dataset.copyState).toBe("copied");
  });

  it.each(["resolve", "reject"] as const)(
    "keeps the replacement copy available before an older write can %s",
    async (settlement) => {
      const pending = createDeferred();
      writeText.mockReturnValueOnce(pending.promise);
      render(renderCopyButton("first"), owner);
      owner.querySelector<HTMLButtonElement>("button")!.click();
      render(renderCopyButton("second"), owner);
      const current = owner.querySelector<HTMLButtonElement>("button")!;
      current.click();
      await vi.advanceTimersByTimeAsync(0);
      if (settlement === "resolve") {
        pending.resolve();
      } else {
        pending.reject(new Error("Synthetic clipboard rejection"));
      }
      await vi.advanceTimersByTimeAsync(0);

      expect(writeText.mock.calls.map(([text]) => text)).toEqual(["first", "second"]);
      expect(fallback).not.toHaveBeenCalled();
      expect(current.dataset.copyState).toBe("copied");
      expect(owner.querySelector("[data-copy-feedback]")?.textContent).toBe("Copied!");
    },
  );

  it("preserves focus, pending fallback, and translated reset labels for unchanged text", async () => {
    const pending = createDeferred();
    writeText.mockReturnValueOnce(pending.promise);
    render(renderCopyButton("same", "Copy text"), owner);
    const button = owner.querySelector<HTMLButtonElement>("button")!;
    button.focus();
    render(renderCopyButton("same", "Copiar texto"), owner);
    expect(document.activeElement).toBe(button);
    button.click();
    render(renderCopyButton("same", "Copier le texte"), owner);
    expect(owner.querySelector("button")).toBe(button);
    expect(button.disabled).toBe(true);
    pending.reject(new Error("Synthetic clipboard rejection"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fallback).toHaveBeenCalledOnce();
    expect(button.getAttribute("aria-label")).toBe("Copied!");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(button.getAttribute("aria-label")).toBe("Copier le texte");
    expect(owner.querySelector<HTMLElement>("[data-copy-feedback]")!.hidden).toBe(true);
  });

  it("does not carry completed feedback or its reset timer to a different payload", async () => {
    render(renderCopyButton("first", "Copy first"), owner);
    owner.querySelector<HTMLButtonElement>("button")!.click();
    await vi.advanceTimersByTimeAsync(0);
    render(renderCopyButton("second", "Copy second"), owner);
    const current = owner.querySelector<HTMLButtonElement>("button")!;
    expect(current.dataset.copyState).toBeUndefined();
    expect(owner.querySelector<HTMLElement>("[data-copy-feedback]")!.hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(current.getAttribute("aria-label")).toBe("Copy second");
  });
});
