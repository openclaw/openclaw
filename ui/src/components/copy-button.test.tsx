import { createSignal, flush } from "solid-js";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { ChatComposerNoticesContent } from "../pages/chat/chat-view-notices-content.tsx";
import { DevicePairSetup } from "../pages/devices/view-pairing.tsx";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { restorePropertyDescriptor } from "../test-helpers/property-descriptor.ts";
import { WizardStepControls } from "./wizard-step-controls.tsx";

const writeText = vi.fn<(text: string) => Promise<void>>();
const fallback = vi.fn(() => true);
function stubProperty(target: object, name: string, value: unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  Object.defineProperty(target, name, { configurable: true, value });
  onTestFinished(() => restorePropertyDescriptor(target, name, descriptor));
}

beforeEach(() => {
  vi.useFakeTimers();
  writeText.mockReset().mockResolvedValue(undefined);
  fallback.mockClear();
  stubProperty(navigator, "clipboard", { writeText });
  stubProperty(document, "execCommand", fallback);
});

afterEach(() => {
  cleanupSolid();
  vi.useRealTimers();
});

const surfaces = [
  {
    name: "wizard code",
    View: (props: { text: string }) => (
      <WizardStepControls
        step={{
          id: "sign-in",
          type: "progress",
          executor: "gateway",
          externalUrl: "https://example.com/device",
          deviceCode: { code: props.text },
        }}
        value={undefined}
        busy={false}
        inputId="wizard-input"
        onValueChange={vi.fn()}
        onAnswer={vi.fn()}
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
      <ChatComposerNoticesContent
        messages={[]}
        workspaceConflict={{
          paths: [props.text],
          stagedResultRef: "refs/openclaw/worker-results/test",
        }}
      />
    ),
    selector: ".chat-workspace-conflict-path-actions button",
  },
];

it.each(surfaces)("retires pending $name copying when its payload changes", async (surface) => {
  const pending = createDeferred();
  writeText.mockReturnValueOnce(pending.promise);
  const [text, setText] = createSignal("first");
  const { container } = mountSolid(() => <surface.View text={text()} />);
  const button = container.querySelector<HTMLButtonElement>(surface.selector)!;
  button.click();
  setText("second");
  flush();
  const current = container.querySelector<HTMLButtonElement>(surface.selector)!;
  expect(current.disabled).toBe(false);
  pending.reject(new Error("Synthetic clipboard rejection"));
  await vi.advanceTimersByTimeAsync(0);

  expect(fallback).not.toHaveBeenCalled();
  current.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(writeText.mock.lastCall?.[0]).toContain("second");
  expect(current.querySelector("[data-copy-label]")?.textContent).toBe("Copied!");
});
