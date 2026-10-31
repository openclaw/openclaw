import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  redactThinkingProbeError,
  resolveThinkingProbeRoute,
  writeThinkingProbeRecord,
  type ThinkingProbeRecord,
} from "./thinking-probe.test-helpers.js";

const record: ThinkingProbeRecord = {
  schemaVersion: 1,
  probedAt: "2026-10-29T12:00:00.000Z",
  provider: "example",
  model: "org/model-1",
  envVar: "EXAMPLE_API_KEY",
  row: { api: "openai-completions", apiKey: { source: "env", id: "EXAMPLE_API_KEY" } },
  turns: [
    {
      level: "off",
      requests: [
        {
          url: "https://api.example.test/v1/chat/completions",
          params: { model: "model-1", reasoning_effort: "none" },
          status: 400,
          error: "thinking cannot be disabled",
        },
      ],
      error: "thinking cannot be disabled",
    },
  ],
};

let rootDir: string | undefined;

async function makeRoot(): Promise<string> {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "thinking-probe-"));
  await fs.mkdir(path.join(rootDir, "extensions", "example"), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, "extensions", "example", "openclaw.plugin.json"),
    JSON.stringify({
      providers: ["example"],
      setup: { providers: [{ id: "example", envVars: ["EXAMPLE_API_KEY"] }] },
    }),
  );
  return rootDir;
}

afterEach(async () => {
  if (rootDir) {
    await fs.rm(rootDir, { recursive: true, force: true });
    rootDir = undefined;
  }
});

describe("writeThinkingProbeRecord", () => {
  it("writes one dated record per route next to the plugin manifest", async () => {
    const root = await makeRoot();
    const planRecord = { ...record, provider: "example-plan", envVar: "EXAMPLE_PLAN_API_KEY" };
    const paths: string[] = [];
    for (const routeRecord of [record, planRecord]) {
      paths.push(
        await writeThinkingProbeRecord({
          rootDir: root,
          plugin: "example",
          record: routeRecord,
          secretValues: ["sk-not-in-record"],
        }),
      );
    }
    expect(paths.map((filePath) => path.relative(root, filePath))).toEqual([
      path.join("extensions", "example", "probes", "org_model-1.example.2026-10-29.json"),
      path.join("extensions", "example", "probes", "org_model-1.example-plan.2026-10-29.json"),
    ]);
    const written = await Promise.all(paths.map((filePath) => fs.readFile(filePath, "utf8")));
    expect(written.map((text) => JSON.parse(text))).toEqual([record, planRecord]);
  });

  it("refuses a record that contains a credential value", async () => {
    const root = await makeRoot();
    await expect(
      writeThinkingProbeRecord({
        rootDir: root,
        plugin: "example",
        record: { ...record, turns: [{ level: "off", requests: [], error: "bad key sk-live-1" }] },
        secretValues: ["sk-live-1"],
      }),
    ).rejects.toThrow("credential value");
    await expect(fs.access(path.join(root, "extensions", "example", "probes"))).rejects.toThrow();
  });
});

describe("resolveThinkingProbeRoute", () => {
  it("reads env var names from the owning manifest", async () => {
    const root = await makeRoot();
    expect(resolveThinkingProbeRoute(root, "example")).toEqual({
      provider: "example",
      plugin: "example",
      envVars: ["EXAMPLE_API_KEY"],
    });
    expect(() => resolveThinkingProbeRoute(root, "other")).toThrow("no plugin manifest");
  });
});

describe("redactThinkingProbeError", () => {
  it("removes account and key ids that provider errors echo", () => {
    expect(
      redactThinkingProbeError(
        "account org-0123456789abcdef0123456789abcdef\\u003cak-abcdefghij0123456789\\u003e hit RPM for kimi-k3.1-pro",
      ),
    ).toBe("account [id]<[id]> hit RPM for kimi-k3.1-pro");
  });
});
