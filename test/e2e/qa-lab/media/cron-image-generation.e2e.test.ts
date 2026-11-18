import { createServer, type ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { TINY_PNG_BASE64 } from "../../../../extensions/qa-lab/api.js";
import { readMockRequests, useMediaGateway } from "./media-gateway.test-support.js";
import { listen } from "./media-http.test-support.js";

const MODEL_REF = "mock-openai/gpt-5.6-luna";
const IMAGE_MODEL_REF = "openai/gpt-image-1";
const waitFor = <T>(callback: () => T | Promise<T>, timeout = 60_000) =>
  vi.waitFor(callback, { interval: 100, timeout });

function writeJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function startImageProvider() {
  let requests = 0;
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/images/generations") {
      writeJson(response, 404, { error: "not found" });
      return;
    }
    request.resume();
    request.on("end", () => {
      requests += 1;
      writeJson(response, 200, { data: [{ b64_json: TINY_PNG_BASE64 }] });
    });
  });
  const listener = await listen(server);
  return { baseUrl: listener.url, requests: () => requests, stop: () => listener.stop() };
}

function configureImageProvider(config: OpenClawConfig, baseUrl: string): OpenClawConfig {
  const openAiProvider = config.models?.providers?.openai;
  if (!openAiProvider) {
    throw new Error("openai image provider is missing from QA gateway config");
  }
  const defaults = ((config.agents ??= {}).defaults ??= {});
  (defaults.mediaModels ??= {}).image = { primary: IMAGE_MODEL_REF };
  openAiProvider.baseUrl = `${baseUrl}/v1`;
  (openAiProvider.request ??= {}).allowPrivateNetwork = true;
  return config;
}

describe("cron image generation", () => {
  const fixture = useMediaGateway();

  it("finishes the cron run after its generated image completes", async () => {
    const imageProvider = await startImageProvider();
    fixture.track(() => imageProvider.stop());
    const { mock, gateway } = await fixture.start({
      primaryModel: MODEL_REF,
      alternateModel: MODEL_REF,
      mutateConfig: (config) => configureImageProvider(config, imageProvider.baseUrl),
    });

    const job = (await gateway.call("cron.add", {
      name: "Cron image E2E",
      agentId: "qa",
      enabled: true,
      schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
      sessionTarget: "isolated",
      payload: {
        kind: "agentTurn",
        message: "Image generation check CRON_IMAGE: generate the QA lighthouse image.",
      },
      delivery: { mode: "none" },
    })) as { id: string };
    const logMark = gateway.markLogs();
    const started = (await gateway.call("cron.run", { id: job.id, mode: "force" })) as {
      runId: string;
    };

    const run = await waitFor(async () => {
      const history = (await gateway.call("cron.runs", {
        id: job.id,
        runId: started.runId,
        limit: 1,
      })) as { entries?: Array<{ runId?: string; status?: string; error?: string }> };
      const entry = history.entries?.find((candidate) => candidate.runId === started.runId);
      expect(entry).toBeDefined();
      return entry;
    }, 90_000);

    expect(run, gateway.readLogsSince(logMark)).toMatchObject({ status: "ok" });
    expect(imageProvider.requests()).toBe(1);
    // The run itself receives the finished image as its tool result.
    const requests = await readMockRequests(mock.baseUrl);
    expect(
      requests.some(
        (request) =>
          request.allInputText.includes("CRON_IMAGE") &&
          request.toolOutput.includes("Generated 1 image"),
      ),
      JSON.stringify(requests.map((request) => request.toolOutput.slice(0, 200))),
    ).toBe(true);
  }, 240_000);
});
