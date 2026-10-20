import { describe, expect, it, vi } from "vitest";
import { ensureMeetingAudioBackend, resolveMeetingAudioRuntimeForFormat } from "./audio-backend.js";
import { createPulseCommands } from "./audio-backend.test-support.js";

const PIPEWIRE_SINK_NAME = "openclaw_meeting_audio";
const PIPEWIRE_MONITOR_NAME = `${PIPEWIRE_SINK_NAME}.monitor`;
const PIPEWIRE_SOURCE_NAME = PIPEWIRE_SINK_NAME;
const defaults = { backend: "auto", bufferBytes: 4_096, format: "pcm16-24khz" } as const;

function pulseRunner(loaded = false) {
  const run = createPulseCommands(loaded);
  return vi.fn(async (argv: string[]) => {
    const { status: code, ...result } = run(argv);
    return { code, ...result };
  });
}

describe("meeting audio backend", () => {
  it("selects the native backend for macOS and Linux", () => {
    expect(resolveMeetingAudioRuntimeForFormat({ ...defaults, platform: "darwin" }).backend).toBe(
      "blackhole-2ch",
    );
    expect(resolveMeetingAudioRuntimeForFormat({ ...defaults, platform: "linux" }).backend).toBe(
      "pipewire-pulse",
    );
    expect(() => resolveMeetingAudioRuntimeForFormat({ ...defaults, platform: "win32" })).toThrow(
      "unsupported on win32",
    );
  });

  it("builds PipeWire-Pulse raw command pairs", () => {
    const runtime = resolveMeetingAudioRuntimeForFormat({
      ...defaults,
      platform: "linux",
    });
    const rawArgs = [
      "--raw",
      `--device=${PIPEWIRE_SOURCE_NAME}`,
      "--format=s16le",
      "--rate=24000",
      "--channels=1",
      "--latency-msec=86",
    ];
    expect(runtime).toMatchObject({
      backend: "pipewire-pulse",
      deviceLabel: "OpenClaw Meeting Audio",
      inputCommand: ["parec", ...rawArgs],
      outputCommand: ["pacat", "--raw", "--playback", ...rawArgs.slice(1)],
    });
  });

  it("preserves explicit command overrides while resolving the host backend", () => {
    expect(
      resolveMeetingAudioRuntimeForFormat({
        ...defaults,
        inputCommand: ["capture"],
        outputCommand: ["playback"],
        platform: "linux",
      }),
    ).toMatchObject({ inputCommand: ["capture"], outputCommand: ["playback"] });
  });

  it("idempotently provisions a PipeWire-Pulse null sink", async () => {
    const run = pulseRunner();

    await ensureMeetingAudioBackend({ backend: "pipewire-pulse", run, timeoutMs: 5_000 });

    expect(run).toHaveBeenCalledWith(
      [
        "pactl",
        "load-module",
        "module-null-sink",
        `sink_name=${PIPEWIRE_SINK_NAME}`,
        "rate=48000",
        "channels=2",
        "channel_map=front-left,front-right",
        `sink_properties='device.description="OpenClaw Meeting Audio"'`,
      ],
      5_000,
    );
    expect(run).toHaveBeenCalledWith(
      [
        "pactl",
        "load-module",
        "module-remap-source",
        `source_name=${PIPEWIRE_SOURCE_NAME}`,
        `master=${PIPEWIRE_MONITOR_NAME}`,
        "channels=2",
        "master_channel_map=front-left,front-right",
        "channel_map=front-left,front-right",
        "remix=no",
        `source_properties='device.description="OpenClaw Meeting Audio"'`,
      ],
      5_000,
    );
  });

  it("does not load a second module when the sink already exists", async () => {
    const run = pulseRunner(true);

    await ensureMeetingAudioBackend({ backend: "pipewire-pulse", run, timeoutMs: 5_000 });

    expect(run.mock.calls.some(([argv]) => argv[1] === "load-module")).toBe(false);
  });
});
