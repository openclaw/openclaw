import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { registerTtsCapabilityCommands } from "./tts.js";

const mocks = vi.hoisted(() => ({
  design: vi.fn(),
  replicate: vi.fn(),
  pin: vi.fn(),
  log: vi.fn(),
  auth: vi.fn(async () => ({ apiKey: "profile-only-fixture", mode: "api-key" })),
}));
vi.mock("../../agents/model-auth.js", () => ({ resolveApiKeyForProviderCore: mocks.auth }));
vi.mock("../../runtime.js", async (original) => ({
  ...(await original<typeof import("../../runtime.js")>()),
  defaultRuntime: {
    log: mocks.log,
    error: (message: string) => {
      throw new Error(message);
    },
    exit: (code: number) => {
      throw new Error(String(code));
    },
  },
}));
vi.mock("./shared.js", async (original) => ({
  ...(await original<typeof import("./shared.js")>()),
  resolveLocalCapabilityRuntimeConfig: async () => ({ tts: { provider: "google" } }),
  pinRuntimeConfigSnapshot: mocks.pin,
}));
vi.mock("../../tts/provider-registry.js", () => ({
  canonicalizeSpeechProviderId: (id: string) => id,
  listSpeechProviders: () => [],
}));
vi.mock("../../tts/tts.js", () => ({
  resolveTtsConfig: () => ({ providerConfigs: {} }),
  resolveTtsPrefsPath: () => "unused",
  getTtsProvider: () => "google",
  designSpeechVoice: mocks.design,
  replicateSpeechVoice: mocks.replicate,
}));
let directory: string | undefined;
afterEach(async () => {
  if (directory) {
    await fs.rm(directory, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

it.each(["design", "replicate"])(
  "hydrates profile-only credentials through the registered %s command",
  async (action) => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "tts-command-"));
    const source = path.join(directory, "source.wav");
    const output = path.join(directory, "preview.wav");
    await fs.writeFile(source, "recording");
    const mutate = action === "design" ? mocks.design : mocks.replicate;
    mutate.mockImplementation(async ({ cfg }) => {
      if (cfg.tts.providers?.google?.apiKey !== "profile-only-fixture") {
        throw new Error("Google API key missing");
      }
      return {
        id: "voice_fixture",
        name: "Test",
        previewAudio: action === "design" ? Buffer.from("preview") : Buffer.alloc(0),
        mimeType: "audio/wav",
      };
    });
    const program = new Command();
    registerTtsCapabilityCommands(program);
    const args =
      action === "design"
        ? ["--prompt", "A gentle voice", "--output", output]
        : ["--source", source, "--consent", source];
    await program.parseAsync(
      ["tts", action, "--name", "Test", "--provider", "google", "--json", ...args],
      { from: "user" },
    );
    expect(mocks.auth).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "google", credentialPrecedence: "profile-first" }),
    );
    expect(mutate).toHaveBeenCalledOnce();
    expect(mocks.pin).toHaveBeenCalledWith(
      expect.objectContaining({
        tts: { provider: "google", providers: { google: { apiKey: "profile-only-fixture" } } },
      }),
    );
    if (action === "design") {
      expect(await fs.readFile(output, "utf8")).toBe("preview");
    } else {
      expect(JSON.parse(mocks.log.mock.calls.at(-1)![0])).toMatchObject({
        id: "voice_fixture",
        outputs: [],
      });
    }
  },
);
