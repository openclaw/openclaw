import "../../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { callGateway } from "../../gateway/call.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { runTtsConvert } from "./tts-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  captureRuntimeConfigAsyncReader: () => async () => ({}),
}));

vi.mock("../../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../gateway/call.js")>()),
  callGateway: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

it.each([true, false])(
  "does not publish interrupted TTS output after reading its source (existing=%s)",
  async (existing) => {
    const dir = tempDirs.make("tts-interrupt-output-");
    const source = path.join(dir, "source.mp3");
    const output = path.join(dir, "speech.mp3");
    const audio = Buffer.alloc(2_048, 0x41);
    await fs.writeFile(source, audio);
    if (existing) {
      await fs.writeFile(output, "existing-speech");
    }
    vi.mocked(callGateway).mockResolvedValueOnce({ audioPath: source, provider: "openai" });
    const scope = new AsyncWorkScope();
    const reason = new Error("command interrupted");
    const readFile = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementationOnce(async () => {
      const buffer = await readFile(source);
      scope.beginClose(reason);
      return buffer;
    });

    await expect(
      scope.track(() => runTtsConvert({ text: "hello", transport: "gateway", output })),
    ).rejects.toBe(reason);
    if (existing) {
      expect(await fs.readFile(output, "utf8")).toBe("existing-speech");
    } else {
      await expect(fs.access(output)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await fs.readFile(source)).toEqual(audio);
    await scope.drain();
  },
);
