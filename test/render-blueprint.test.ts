import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type RenderEnvVar = {
  key?: string;
  value?: string;
};

type RenderService = {
  type?: string;
  runtime?: string;
  healthCheckPath?: string;
  dockerCommand?: string;
  envVars?: RenderEnvVar[];
};

describe("render blueprint", () => {
  it("overrides the Dockerfile defaults with a Render-compatible gateway command", () => {
    const renderYamlPath = fileURLToPath(new URL("../render.yaml", import.meta.url));
    const parsed = parse(fs.readFileSync(renderYamlPath, "utf8")) as {
      services?: RenderService[];
    };
    const service = parsed.services?.[0];

    expect(service?.type).toBe("web");
    expect(service?.runtime).toBe("docker");
    expect(service?.healthCheckPath).toBe("/health");
    expect(service?.dockerCommand).toBe(
      "node openclaw.mjs gateway --allow-unconfigured --bind lan --port 8080",
    );

    const env = new Map((service?.envVars ?? []).map((entry) => [entry.key, entry.value]));
    expect(env.get("PORT")).toBe("8080");
  });
});
