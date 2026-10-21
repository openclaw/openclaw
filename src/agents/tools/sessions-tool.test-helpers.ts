import { expect } from "vitest";
import {
  prepareSystemAgentRunAdmission,
  type AdmittedRunOperatorAuthority,
} from "../admitted-run-context.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";

const overlongUnicode = (unit: string, maxLength: number) => `${unit.repeat(maxLength - 1)}🦞tail`;

function resolvedFixture(escaped = false) {
  const text = escaped ? () => "\0".repeat(10_000) : overlongUnicode;
  return {
    modelProvider: text("界", 48),
    model: text("模", 96),
    agentRuntime: {
      id: text("運", 48),
      fallback: escaped ? ("none" as const) : ("openclaw" as const),
      source: escaped ? ("provider" as const) : ("session-key" as const),
    },
    thinkingLevel: text("考", 16),
    thinkingLevels: Array.from({ length: 12 }, (_, index) => ({
      id: `${index}:${text("識", 12)}`,
      label: `${index}:${text("思", 16)}`,
    })),
  };
}
export const adversarialResolved = resolvedFixture();
export const escapeHeavyResolved = resolvedFixture(true);

export const expectedResolvedOmission = { reason: "response_budget_exceeded" } as const;

type Acknowledgement = { content: Array<{ type: string; text?: string }>; details: unknown };

export function expectExactResolvedAcknowledgement(result: Acknowledgement, expected: unknown) {
  expect((result.details as { resolved?: unknown }).resolved).toEqual(expected);
  const text = result.content[0]?.text ?? "";
  expect(JSON.parse(text)).toEqual(result.details);
  expect(text).not.toMatch(/"entry"|"path"|skillsSnapshot/);
  expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(3_840);
}

export function expectOmittedResolvedAcknowledgement(result: Acknowledgement) {
  expectExactResolvedAcknowledgement(result, undefined);
  expect(result.details).toMatchObject({ resolvedOmitted: expectedResolvedOmission });
}

export async function withSessionToolTestCaller<T>(
  run: () => Promise<T>,
  operatorAuthority?: AdmittedRunOperatorAuthority,
): Promise<T> {
  const admission = prepareSystemAgentRunAdmission(
    {},
    "session-tool-test",
    "main",
    "session-tool-test",
    undefined,
    operatorAuthority,
  );
  try {
    const admittedRunContext = await admission.admit("gateway", "session-tool-test");
    const caller = createAdmittedGatewayToolCallerIdentity({
      admittedRunContext,
      agentId: "main",
      sessionKey: "agent:main:main",
    });
    return await withGatewayToolCallerIdentity(caller, run);
  } finally {
    admission.close();
  }
}
