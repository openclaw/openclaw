/** Tests exec-ref resolution policy splitting and skipped-ref static validation. */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretRef } from "../config/types.secrets.js";
import { getSkippedExecRefStaticError, selectRefsForExecPolicy } from "./exec-resolution-policy.js";
import { formatExecSecretRefIdValidationMessage } from "./ref-contract.js";

const envRef: SecretRef = { source: "env", provider: "default", id: "OPENAI_API_KEY" };
const fileRef: SecretRef = { source: "file", provider: "mounted-json", id: "/providers/openai" };
const execRef: SecretRef = { source: "exec", provider: "vault", id: "openai/api-key" };

function configWithProvider(provider: string, source: string): OpenClawConfig {
  return {
    secrets: { providers: { [provider]: { source } } },
  } as unknown as OpenClawConfig;
}

describe("selectRefsForExecPolicy", () => {
  it("skips exec refs but keeps non-exec refs when allowExec is false", () => {
    const { refsToResolve, skippedExecRefs } = selectRefsForExecPolicy({
      refs: [envRef, fileRef, execRef],
      allowExec: false,
    });

    expect(refsToResolve).toEqual([envRef, fileRef]);
    expect(skippedExecRefs).toEqual([execRef]);
  });

  it("resolves exec refs when allowExec is true", () => {
    const { refsToResolve, skippedExecRefs } = selectRefsForExecPolicy({
      refs: [envRef, execRef],
      allowExec: true,
    });

    expect(refsToResolve).toEqual([envRef, execRef]);
    expect(skippedExecRefs).toEqual([]);
  });

  it("returns empty splits for empty input", () => {
    const { refsToResolve, skippedExecRefs } = selectRefsForExecPolicy({
      refs: [],
      allowExec: false,
    });

    expect(refsToResolve).toEqual([]);
    expect(skippedExecRefs).toEqual([]);
  });
});

describe("getSkippedExecRefStaticError", () => {
  it("reports an empty id error when the ref id is blank", () => {
    const error = getSkippedExecRefStaticError({
      ref: { source: "exec", provider: "vault", id: "   " },
      config: configWithProvider("vault", "exec"),
    });

    expect(error).toBe("Error: Secret reference id is empty.");
  });

  it("reports a grammar validation error for invalid exec ids", () => {
    const error = getSkippedExecRefStaticError({
      ref: { source: "exec", provider: "vault", id: "../escape" },
      config: configWithProvider("vault", "exec"),
    });

    expect(error).toBe(
      `Error: ${formatExecSecretRefIdValidationMessage()} (ref: exec:vault:../escape).`,
    );
  });

  it("reports an unconfigured provider error", () => {
    const error = getSkippedExecRefStaticError({
      ref: execRef,
      config: { secrets: { providers: {} } } as unknown as OpenClawConfig,
    });

    expect(error).toBe(
      'Error: Secret provider "vault" is not configured (ref: exec:vault:openai/api-key).',
    );
  });

  it("reports a source mismatch error when provider source differs", () => {
    const error = getSkippedExecRefStaticError({
      ref: execRef,
      config: configWithProvider("vault", "env"),
    });

    expect(error).toBe('Error: Secret provider "vault" has source "env" but ref requests "exec".');
  });

  it("returns null when the skipped exec ref is statically valid", () => {
    const error = getSkippedExecRefStaticError({
      ref: execRef,
      config: configWithProvider("vault", "exec"),
    });

    expect(error).toBeNull();
  });
});
