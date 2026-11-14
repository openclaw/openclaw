import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { startRestartStressProvider } from "../../scripts/perf/team-shape-restart-provider.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
const executeFile = promisify(execFile);

it("rejects unsupported provider targets and pins the Responses upstream", async () => {
  const upstream = vi.fn<typeof fetch>().mockImplementation(async () => new Response("synthetic"));
  vi.stubGlobal("fetch", upstream);
  const provider = await startRestartStressProvider({
    dry: false,
    model: "approved-stress-model",
    onActivity() {},
    onSustainedRateLimit() {},
  });
  const address = new URL(provider.baseUrl);
  const post = (target: string) =>
    new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        {
          hostname: address.hostname,
          port: address.port,
          path: target,
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer synthetic" },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ model: "stress-primary", input: "INPUT_test" }));
    });
  try {
    expect(await post("/unexpected-provider-target")).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
    expect(await post("/v1/responses")).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
    expect(upstream.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/responses");
    const body = upstream.mock.calls[0]?.[1]?.body;
    expect(typeof body).toBe("string");
    if (typeof body !== "string") {
      throw new Error("Expected a JSON request body");
    }
    expect(JSON.parse(body)).toMatchObject({
      model: "approved-stress-model",
    });
  } finally {
    await provider.close();
    vi.unstubAllGlobals();
  }
});

it.skipIf(process.platform === "win32")(
  "inspects the exact synthetic effect before repeating an exec after resume",
  async () => {
    const root = temporary.make("restart-stress-provider-");
    const effect = path.join(root, "input.effects");
    await writeFile(effect, "EFFECT_fixture-suffix\n");
    const provider = await startRestartStressProvider({
      dry: true,
      model: "stress-mock",
      onActivity() {},
      onSustainedRateLimit() {},
    });
    const original = { role: "user", content: `INPUT_fixture EFFECT_PATH=${effect}` };
    try {
      for (const resumed of [false, true]) {
        const response = await fetch(`${provider.baseUrl}/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "stress-primary",
            tools: [{ name: "exec" }],
            input: resumed
              ? [
                  original,
                  { type: "function_call_output", output: "The command completed." },
                  { role: "user", content: "The Gateway restarted. Check before repeating work." },
                ]
              : [original],
          }),
        });
        expect(response.status).toBe(200);
        const events: unknown[] = (await response.text())
          .split("\n")
          .filter((line) => line.startsWith("data: {"))
          .map((line) => JSON.parse(line.slice("data: ".length)));
        const completed = expectDefined(
          events.find((event) => isRecord(event) && event.type === "response.output_item.done"),
          "exec tool call",
        );
        if (!isRecord(completed) || !isRecord(completed.item)) {
          throw new Error("Expected an exec tool item");
        }
        expect(completed.item.name).toBe("exec");
        if (typeof completed.item.arguments !== "string") {
          throw new Error("Expected serialized exec arguments");
        }
        const args: unknown = JSON.parse(completed.item.arguments);
        if (!isRecord(args) || typeof args.command !== "string") {
          throw new Error("Expected an exec command");
        }
        // Keep the real shell command; only the workload's sleep is irrelevant to this proof.
        await executeFile("/bin/sh", ["-c", `sleep() { :; }\n${args.command}`]);
      }
      expect(await readFile(effect, "utf8")).toBe("EFFECT_fixture-suffix\nEFFECT_fixture\n");
    } finally {
      await provider.close();
    }
  },
);
