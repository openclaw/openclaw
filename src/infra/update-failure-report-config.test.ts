import { expect, it } from "vitest";
import { createUpdateConfigFailure } from "../cli/update-cli/update-command-config-failure.js";
import { createConfigFileSnapshot } from "../config/io.snapshot-shared.js";
import { validateConfigObjectRaw } from "../config/validation-core.js";
import { createUpdateFailureFact } from "./update-failure-facts.js";
import { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";

const context = { env: {}, stateDir: "/report-config-test" };

async function renderConfigFailure(raw: unknown, candidate: boolean) {
  const validated = validateConfigObjectRaw(raw);
  expect(validated.ok).toBe(false);
  if (validated.ok) {
    throw new Error("Fixture must fail validation");
  }
  const failure = createUpdateConfigFailure(
    createConfigFileSnapshot({
      path: "/home/private-operator/private-config.json",
      exists: true,
      raw: JSON.stringify(raw),
      parsed: raw,
      sourceConfig: {},
      runtimeConfig: {},
      valid: false,
      issues: validated.issues,
      warnings: [],
      legacyIssues: [],
    }),
  );
  const facts = candidate
    ? [{ check: "candidate-admission", code: "invalid-config", message: failure.message }]
    : (failure.failureFacts ?? []);
  return (
    await prepareUpdateFailureReport(
      {
        attemptId: "config-report",
        result: {
          mode: "npm",
          status: "error",
          reason: "invalid-config",
          durationMs: 1,
          steps: [
            {
              name: "invalid-config",
              command: "",
              cwd: "",
              durationMs: 1,
              exitCode: 1,
              failureFacts: facts.map((fact) => createUpdateFailureFact(fact, {})),
            },
          ],
        },
      },
      context,
    )
  ).body;
}

it.each([false, true])(
  "keeps validator-owned paths and issue kinds (candidate=%s)",
  async (candidate) => {
    const body = await renderConfigFailure(
      { gateway: { port: "private-rejected-value" } },
      candidate,
    );
    expect(body).toContain("gateway.port: expected number, got string");
    expect(body).not.toMatch(/private-rejected-value|private-operator|private-config/);
  },
);

it.each([
  {
    raw: { agents: { entries: { "private-agent": { model: { primary: 123 } } } } },
    expected: "agents.entries.<id>.model.primary: expected string, got number",
  },
  {
    raw: { auth: { profiles: { "private-profile": { provider: 42, mode: "api_key" } } } },
    expected: "auth.profiles.<id>.provider: expected string, got number",
  },
  {
    raw: {
      models: {
        providers: { "private-provider": { baseUrl: 123, models: [] } },
      },
    },
    expected: "models.providers.<id>.baseUrl: expected string, got number",
  },
  {
    raw: { skills: { workshop: { approvalPolicy: "private-value" } } },
    expected: "skills.workshop: unrecognized key approvalPolicy",
  },
  {
    raw: { skills: { workshop: { "private-key": "private-value" } } },
    expected: "skills.workshop: unrecognized key <key>",
  },
  {
    raw: { auth: { profiles: { "private-profile": { mode: "api_key" } } } },
    expected: "auth.profiles.<id>.provider: missing required",
  },
])("publishes only schema vocabulary: $expected", async ({ raw, expected }) => {
  const body = await renderConfigFailure(raw, false);
  expect(body).toContain(expected);
  expect(body).not.toMatch(
    /private-profile|private-provider|private\.example|private-key|private-value/,
  );
});

it.each([
  "alice@example.invalid",
  "/Users/private-operator/private-file",
  "C:\\Users\\private-operator\\file",
  "https://user:password@private.example/config",
  "10.20.30.40",
  "+1 415 555 0199",
  "sk-private-token",
])("never publishes dynamic map identities or unknown values: %s", async (privateValue) => {
  const body = await renderConfigFailure(
    {
      agents: {
        entries: { "private-agent": { sandbox: { docker: { env: { [privateValue]: 123 } } } } },
      },
    },
    false,
  );
  expect(body).toContain("agents.entries.<id>.sandbox.docker.env.<id>");
  expect(body).not.toContain(privateValue);
  expect(body).not.toContain("private-agent");
});

it("keeps scrubbed candidate details local while publishing the fixed config cause", async () => {
  const fact = createUpdateFailureFact({
    check: "config",
    code: "candidate-config-failed",
    affectedKey: "gateway.port",
    message: "Configuration unavailable for private-tenant at /home/private-owner/config.json",
  });
  expect(fact.message).toContain("Configuration unavailable");
  const report = await prepareUpdateFailureReport(
    {
      attemptId: "private-config-cause",
      result: {
        mode: "npm",
        status: "error",
        durationMs: 1,
        steps: [
          {
            name: "candidate-config",
            command: "config validate",
            cwd: "",
            durationMs: 1,
            exitCode: 1,
            failureFacts: [fact],
          },
        ],
      },
    },
    context,
  );
  expect(report.body).toContain("gateway.port: Invalid configuration field");
  expect(report.body).not.toMatch(
    /Configuration unavailable|private-tenant|private-owner|\/home\//u,
  );
});
