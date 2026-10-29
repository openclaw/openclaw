/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { MicrophoneActivity } from "../components/chat-voice-activity.tsx";
import { RealtimeTalkLevelSignal } from "./level.ts";
import type { createMicrophoneMeter } from "./microphone-meter.ts";
import type { RealtimeTalkStatus } from "./session.ts";

const renderer = vi.hoisted(() => ({ create: vi.fn<typeof createMicrophoneMeter>() }));
vi.mock("./microphone-meter.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./microphone-meter.ts")>()),
  createMicrophoneMeter: renderer.create,
}));
beforeEach(() => {
  renderer.create.mockReset();
  renderer.create.mockImplementation(() => ({ setLevel: vi.fn(), dispose: vi.fn() }));
});
afterEach(() => vi.restoreAllMocks());

it("keeps silence in CSS and preserves the first level transition when activity begins", async () => {
  const source = new RealtimeTalkLevelSignal();
  const view = mountSolid(() => <MicrophoneActivity status="listening" inputLevel={source} />);
  try {
    await waitForSolid(() =>
      expect(
        view.container.querySelector("openclaw-microphone-activity")?.getAttribute("data-level"),
      ).toBe("0"),
    );
    expect(renderer.create).not.toHaveBeenCalled();
    const host = view.container.querySelector("openclaw-microphone-activity");
    const bars = Array.from(view.container.querySelectorAll(".agent-chat__voice-activity-bar"));

    source.set(0.6);
    expect(renderer.create).toHaveBeenCalledOnce();
    const active = expectDefined(renderer.create.mock.results[0], "active renderer").value;
    expect(vi.mocked(active.setLevel).mock.calls).toEqual([[0], [0.6]]);
    expect(host?.getAttribute("data-level")).toBe("0.6");
    expect(Array.from(view.container.querySelectorAll(".agent-chat__voice-activity-bar"))).toEqual(
      bars,
    );

    source.set(0);
    expect(renderer.create).toHaveBeenCalledOnce();
    expect(active.setLevel).toHaveBeenLastCalledWith(0);
  } finally {
    view.unmount();
  }
});

it("keeps the host and bars while replacing only the status/source canvas lifetime", async () => {
  const warnings = vi.spyOn(console, "warn");
  const firstSource = new RealtimeTalkLevelSignal();
  firstSource.set(0.2);
  const [source, setSource] = createSignal(firstSource);
  const [status, setStatus] = createSignal<RealtimeTalkStatus>("listening");
  const view = mountSolid(() => <MicrophoneActivity status={status()} inputLevel={source()} />);
  let mounted = true;
  try {
    await waitForSolid(() => expect(renderer.create).toHaveBeenCalledTimes(1));
    const host = view.container.querySelector("openclaw-microphone-activity");
    const bars = Array.from(view.container.querySelectorAll(".agent-chat__voice-activity-bar"));
    const firstCanvas = host?.querySelector("canvas");
    const first = expectDefined(renderer.create.mock.results[0], "first renderer").value;
    expect(bars).toHaveLength(7);
    expect(first.setLevel).toHaveBeenLastCalledWith(0.2);

    firstSource.set(0.8);
    setStatus("idle"); // The same normalized visual status must retain its lifetime.
    await waitForSolid(() => expect(host?.getAttribute("data-level")).toBe("0.8"));
    expect(renderer.create).toHaveBeenCalledTimes(1);
    expect(first.setLevel).toHaveBeenLastCalledWith(0.8);
    expect(host?.querySelector("canvas")).toBe(firstCanvas);

    setStatus("thinking");
    await waitForSolid(() => expect(renderer.create).toHaveBeenCalledTimes(2));
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(host?.querySelector("canvas")).not.toBe(firstCanvas);
    expect(expectDefined(renderer.create.mock.calls[1], "thinking renderer call")[3]).toBe(
      "thinking",
    );
    const second = expectDefined(renderer.create.mock.results[1], "second renderer").value;
    expect(second.setLevel).toHaveBeenLastCalledWith(0.8);
    expect(view.container.querySelector("openclaw-microphone-activity")).toBe(host);
    expect(Array.from(view.container.querySelectorAll(".agent-chat__voice-activity-bar"))).toEqual(
      bars,
    );

    const replacement = new RealtimeTalkLevelSignal();
    replacement.set(0.35);
    setSource(replacement);
    await waitForSolid(() => expect(renderer.create).toHaveBeenCalledTimes(3));
    const third = expectDefined(renderer.create.mock.results[2], "third renderer").value;
    expect(second.dispose).toHaveBeenCalledOnce();
    expect(third.setLevel).toHaveBeenLastCalledWith(0.35);
    const retiredCalls = vi.mocked(second.setLevel).mock.calls.length;
    firstSource.set(0.1);
    expect(vi.mocked(second.setLevel).mock.calls).toHaveLength(retiredCalls);

    view.unmount();
    mounted = false;
    expect(third.dispose).toHaveBeenCalledOnce();
    const finalCalls = vi.mocked(third.setLevel).mock.calls.length;
    replacement.set(0.9);
    expect(vi.mocked(third.setLevel).mock.calls).toHaveLength(finalCalls);
    expect(warnings.mock.calls.flat().join(" ")).not.toContain("STRICT_READ_UNTRACKED");
  } finally {
    if (mounted) {
      view.unmount();
    }
  }
});

it("uses CSS while connecting and adopts the live source when the meter becomes active", async () => {
  const connectingSource = new RealtimeTalkLevelSignal();
  connectingSource.set(0.2);
  const [source, setSource] = createSignal(connectingSource);
  const [status, setStatus] = createSignal<RealtimeTalkStatus>("connecting");
  const view = mountSolid(() => <MicrophoneActivity status={status()} inputLevel={source()} />);
  try {
    await waitForSolid(() =>
      expect(
        view.container.querySelector("openclaw-microphone-activity")?.getAttribute("data-level"),
      ).toBe("0"),
    );
    expect(renderer.create).not.toHaveBeenCalled();
    const host = view.container.querySelector("openclaw-microphone-activity");
    const bars = Array.from(view.container.querySelectorAll(".agent-chat__voice-activity-bar"));
    expect(host?.querySelector("canvas")).toBeNull();
    connectingSource.set(0.6);
    expect(host?.getAttribute("data-level")).toBe("0");

    setStatus("listening");
    await waitForSolid(() => expect(renderer.create).toHaveBeenCalledTimes(1));
    const active = expectDefined(renderer.create.mock.results[0], "active renderer").value;
    expect(active.setLevel).toHaveBeenLastCalledWith(0.6);
    expect(Array.from(view.container.querySelectorAll(".agent-chat__voice-activity-bar"))).toEqual(
      bars,
    );

    setStatus("connecting");
    await waitForSolid(() => expect(active.dispose).toHaveBeenCalledOnce());
    expect(renderer.create).toHaveBeenCalledTimes(1);
    expect(host?.querySelector("canvas")).toBeNull();
    const replacement = new RealtimeTalkLevelSignal();
    replacement.set(0.35);
    setSource(replacement);
    await waitForSolid(() => expect(host?.getAttribute("data-level")).toBe("0.6"));
    connectingSource.set(0.9);
    expect(host?.getAttribute("data-level")).toBe("0.6");

    setStatus("thinking");
    await waitForSolid(() => expect(renderer.create).toHaveBeenCalledTimes(2));
    expect(expectDefined(renderer.create.mock.calls[1], "thinking renderer call")[3]).toBe(
      "thinking",
    );
    const thinking = expectDefined(renderer.create.mock.results[1], "thinking renderer").value;
    expect(thinking.setLevel).toHaveBeenLastCalledWith(0.35);
  } finally {
    view.unmount();
  }
});
