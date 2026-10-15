import { createSignal, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { LitContent } from "../lit/solid-content.tsx";
import { renderWorkspaceConflictNotice } from "../pages/chat/components/chat-workspace-conflict.ts";
import { DevicePairSetup } from "../pages/devices/view-pairing.tsx";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { renderWizardStepControls } from "./wizard-step-controls.ts";

const writeText = vi.fn<(text: string) => Promise<void>>();
const fallback = vi.fn(() => true);
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");

beforeEach(() => {
  vi.useFakeTimers();
  writeText.mockReset().mockResolvedValue(undefined);
  fallback.mockClear();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  Object.defineProperty(document, "execCommand", { configurable: true, value: fallback });
});

afterEach(() => {
  cleanupSolid();
  vi.useRealTimers();
  if (clipboardDescriptor) {
    Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, "clipboard");
  }
  if (execCommandDescriptor) {
    Object.defineProperty(document, "execCommand", execCommandDescriptor);
  } else {
    Reflect.deleteProperty(document, "execCommand");
  }
});

const surfaces = [
  {
    name: "wizard code",
    View: (props: { text: string }) => (
      <LitContent
        value={renderWizardStepControls({
          step: {
            id: "sign-in",
            type: "progress",
            executor: "gateway",
            externalUrl: "https://example.com/device",
            deviceCode: { code: props.text },
          },
          value: undefined,
          busy: false,
          inputId: "wizard-input",
          onValueChange: vi.fn(),
          onAnswer: vi.fn(),
        })}
      />
    ),
    selector: ".wizard-step__actions button",
  },
  {
    name: "device pairing code",
    View: (props: { text: string }) => (
      <DevicePairSetup
        open
        lifecycle={{
          phase: "waiting",
          access: "full",
          setup: {
            setupId: "setup",
            setupCode: props.text,
            gatewayUrl: "wss://gateway.example",
            auth: "token",
            urlSource: "test",
            access: "full",
            expiresAtMs: 70_000,
          },
        }}
        nowMs={10_000}
        pendingCount={0}
        onRefresh={vi.fn()}
        onAccessChange={vi.fn()}
        onClose={vi.fn()}
        onManageDevices={vi.fn()}
        onGetApps={vi.fn()}
      />
    ),
    selector: ".device-pair-setup__actions button:has([data-copy-label])",
  },
  {
    name: "workspace conflict command",
    View: (props: { text: string }) => (
      <LitContent
        value={renderWorkspaceConflictNotice({
          conflict: { paths: [props.text], stagedResultRef: "refs/openclaw/worker-results/test" },
        })}
      />
    ),
    selector: ".chat-workspace-conflict-path-actions button",
  },
];

describe("copy payload lifetime", () => {
  it.each(surfaces)("retires pending $name copying when its payload changes", async (surface) => {
    const pending = createDeferred();
    writeText.mockReturnValueOnce(pending.promise);
    const [text, setText] = createSignal("first");
    const { container } = mountSolid(() => <surface.View text={text()} />);
    const button = container.querySelector<HTMLButtonElement>(surface.selector)!;
    button.click();
    expect(writeText).toHaveBeenCalledOnce();
    setText("second");
    flush();
    const current = container.querySelector<HTMLButtonElement>(surface.selector)!;
    expect(current.disabled).toBe(false);
    pending.reject(new Error("Synthetic clipboard rejection"));
    await vi.advanceTimersByTimeAsync(0);

    expect(fallback).not.toHaveBeenCalled();
    expect(current.dataset.copyState).toBeUndefined();
    current.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText.mock.lastCall?.[0]).toContain("second");
    expect(current.dataset.copyState).toBe("copied");
  });
});
