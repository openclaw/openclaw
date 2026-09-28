import { describe, expect, it } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  prepareDoctorConfigReferenceSource,
  restoreDoctorConfigEnvRefs,
} from "./config-flow-steps.js";

function pairedSnapshot(authored: OpenClawConfig, resolved: OpenClawConfig): ConfigFileSnapshot {
  return {
    path: "/fixture/openclaw.json",
    exists: true,
    raw: JSON.stringify(authored),
    parsed: authored,
    authoredConfig: authored,
    sourceConfigBeforeMigrations: resolved,
    sourceConfig: resolved,
    resolved,
    config: resolved,
    runtimeConfig: resolved,
    valid: true,
    issues: [],
    warnings: [],
    legacyIssues: [],
  };
}

describe("Doctor planning reference intent", () => {
  it("preserves an explicitly activated reference at an unchanged path", () => {
    const candidate = { browser: { executablePath: "${BROWSER_BIN}" } };
    const source = prepareDoctorConfigReferenceSource(
      pairedSnapshot({ browser: { executablePath: "$${BROWSER_BIN}" } }, candidate),
    );
    expect(restoreDoctorConfigEnvRefs(candidate, source, [["browser", "executablePath"]])).toEqual(
      candidate,
    );
    expect(restoreDoctorConfigEnvRefs(candidate, source)).toEqual({
      browser: { executablePath: "$${BROWSER_BIN}" },
    });
  });

  it("preserves an explicitly activated reference at a migrated destination", () => {
    const source = prepareDoctorConfigReferenceSource(
      pairedSnapshot(
        {
          agents: { defaults: { memorySearch: { remote: { apiKey: "$${MEMORY_KEY}" } } } },
        } as OpenClawConfig,
        {
          agents: { defaults: { memorySearch: { remote: { apiKey: "${MEMORY_KEY}" } } } },
        } as OpenClawConfig,
      ),
    );
    const candidate = { memory: { search: { remote: { apiKey: "${MEMORY_KEY}" } } } };
    expect(
      restoreDoctorConfigEnvRefs(candidate, source, [["memory", "search", "remote", "apiKey"]]),
    ).toEqual(candidate);
    expect(restoreDoctorConfigEnvRefs(candidate, source).memory?.search?.remote?.apiKey).toBe(
      "$${MEMORY_KEY}",
    );
  });
});
