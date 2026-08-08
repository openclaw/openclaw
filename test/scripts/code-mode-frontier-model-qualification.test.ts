import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  resolveFrontierModelQualification,
  resolveFrontierModelQualificationFromManifest,
} from "../../scripts/lib/code-mode-frontier-model-qualification.js";

describe("Code Mode frontier model qualification", () => {
  it("accepts the bundled supported frontier model", async () => {
    await expect(resolveFrontierModelQualification("openai/gpt-5.6")).resolves.toMatchObject({
      ok: true,
      receipt: {
        api: "openai-responses",
        codeMode: "preferred",
        endpoint: "https://api.openai.com/v1",
        modelRef: "openai/gpt-5.6",
        source: "bundled_openai_manifest",
        status: "available",
      },
    });
  });

  it("rejects an allowlisted model whose catalog row does not advertise Code Mode", async () => {
    await expect(resolveFrontierModelQualification("openai/gpt-5.4")).resolves.toEqual({
      ok: false,
      reason: "code_mode_unsupported",
    });
  });

  it("rejects malformed and capability-drifted manifests", async () => {
    expect(
      resolveFrontierModelQualificationFromManifest({
        manifestText: "{",
        modelRef: "openai/gpt-5.6",
      }),
    ).toEqual({ ok: false, reason: "manifest_invalid" });

    const manifestUrl = new URL("../../extensions/openai/openclaw.plugin.json", import.meta.url);
    const manifest = JSON.parse(await fs.readFile(manifestUrl, "utf8")) as {
      modelCatalog: {
        providers: { openai: { models: Array<{ id: string; compat?: Record<string, unknown> }> } };
      };
    };
    const model = manifest.modelCatalog.providers.openai.models.find(
      (entry) => entry.id === "gpt-5.6",
    );
    delete model?.compat;
    expect(
      resolveFrontierModelQualificationFromManifest({
        manifestText: JSON.stringify(manifest),
        modelRef: "openai/gpt-5.6",
      }),
    ).toEqual({ ok: false, reason: "code_mode_unsupported" });
  });
});
