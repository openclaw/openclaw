// Covers diagnostic model-content capture policy.
import { describe, expect, it, vi } from "vitest";
import { resolveDiagnosticModelContentCapturePolicy } from "./diagnostic-llm-content.js";

describe("resolveDiagnosticModelContentCapturePolicy", () => {
  it("requires diagnostics, otel, traces, and explicit content capture", () => {
    expect(resolveDiagnosticModelContentCapturePolicy({})).toMatchObject({
      anyModelContent: false,
      toolInputs: false,
      toolOutputs: false,
    });
    expect(
      resolveDiagnosticModelContentCapturePolicy({
        diagnostics: { enabled: false, otel: { enabled: true, captureContent: true } },
      }).anyModelContent,
    ).toBe(false);
    expect(
      resolveDiagnosticModelContentCapturePolicy({
        diagnostics: {
          enabled: true,
          otel: { enabled: true, traces: false, captureContent: true },
        },
      }).anyModelContent,
    ).toBe(false);
    expect(
      resolveDiagnosticModelContentCapturePolicy({
        diagnostics: { enabled: true, otel: { enabled: true, captureContent: true } },
      }),
    ).toMatchObject({
      inputMessages: true,
      outputMessages: true,
      toolInputs: true,
      toolOutputs: true,
      systemPrompt: false,
      toolDefinitions: true,
      anyModelContent: true,
    });
    expect(
      resolveDiagnosticModelContentCapturePolicy({
        diagnostics: { otel: { enabled: true, captureContent: true } },
      }),
    ).toMatchObject({
      inputMessages: true,
      outputMessages: true,
      toolInputs: true,
      toolOutputs: true,
      systemPrompt: false,
      toolDefinitions: true,
      anyModelContent: true,
    });
  });

  it("rejects the retired object form of content capture", () => {
    expect(
      resolveDiagnosticModelContentCapturePolicy({
        diagnostics: {
          enabled: true,
          otel: {
            enabled: true,
            captureContent: {
              enabled: true,
              inputMessages: true,
              outputMessages: false,
              toolInputs: true,
              toolOutputs: true,
              systemPrompt: true,
              toolDefinitions: true,
            },
          },
        },
      }),
    ).toMatchObject({
      inputMessages: false,
      outputMessages: false,
      toolInputs: false,
      toolOutputs: false,
      systemPrompt: false,
      toolDefinitions: false,
      anyModelContent: false,
    });
  });
});

it.each(["dashboard", "subagent", "internal-session-effects"])(
  "disables all capture for Incognito %s before reading optional config",
  (kind) => {
    const diagnostics = vi.fn(() => ({ otel: { enabled: true, captureContent: true } }));
    const config = {
      get diagnostics() {
        return diagnostics();
      },
    };
    expect(
      resolveDiagnosticModelContentCapturePolicy(config, `agent:main:${kind}:incognito-test`),
    ).toEqual({
      inputMessages: false,
      outputMessages: false,
      toolInputs: false,
      toolOutputs: false,
      systemPrompt: false,
      toolDefinitions: false,
      anyModelContent: false,
    });
    expect(diagnostics).not.toHaveBeenCalled();
    expect(
      resolveDiagnosticModelContentCapturePolicy(config, "agent:main:main").anyModelContent,
    ).toBe(true);
  },
);
