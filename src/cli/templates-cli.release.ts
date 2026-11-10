import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { listAgentEntries } from "../agents/agent-scope-config.js";
import { getRuntimeConfig } from "../config/config.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSqliteWorkerWriteAdmission } from "../infra/sqlite-worker-store.js";
import { normalizeAgentIdStrict } from "../routing/session-key.js";
import { defaultRuntime as runtime } from "../runtime.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { collectTemplateToolPolicyCandidates } from "../templates/tool-policy-candidates.js";
import { matchTemplateConsent } from "../templates/tool-policy-runtime.js";
import { runWithLocalStateOwner } from "./local-state-owner.js";
import { promptYesNo } from "./prompt.js";
import type { TemplatesReleaseOptions } from "./templates-cli.js";

function fail(message: string): void {
  runtime.error(message);
  runtime.exit(1);
}

export async function runTemplatesReleaseCommand(
  input: string,
  opts: TemplatesReleaseOptions,
): Promise<void> {
  const normalized = normalizeAgentIdStrict(input);
  if (!normalized.ok) {
    fail(`Agent id ${JSON.stringify(input)} is not valid.`);
    return;
  }
  const agentId = normalized.value;
  await runWithLocalStateOwner({
    method: "templates.release",
    params: {},
    target: `Template ownership of agent ${JSON.stringify(agentId)}`,
    onForeignOwner: "refuse",
    runLocal: async ({ env }) => {
      const config = getRuntimeConfig();
      const agent = listAgentEntries(config).find((entry) => entry.id === agentId);
      if (!agent) {
        fail(`Agent ${JSON.stringify(agentId)} is not configured. Run \`openclaw agents list\`.`);
        return;
      }
      const context = captureOpenClawStateWorkerContext({ env });
      const rows = await runOpenClawStateWorkerOperation(
        context,
        (scope) =>
          scope.execute({
            type: "templates.install-schema-versions",
            input: { artifactPreservingReadOnly: false },
          }),
        { existingOnly: true },
      );
      const record = rows?.find((row) => row.agentId === agentId);
      if (!record) {
        runtime.log(`Agent ${agentId} is not Template-managed. Nothing to release.`);
        return;
      }

      const candidate = collectTemplateToolPolicyCandidates(config).find(
        (entry) => entry.agentId === agentId,
      );
      runtime.log(`Agent: ${agentId}`);
      if (candidate) {
        try {
          const consent = matchTemplateConsent(candidate, record, env);
          runtime.log(
            consent === "current"
              ? "Its settings match the Template consent."
              : consent === "changed"
                ? "Its settings changed after the Template consent was recorded."
                : "It uses a legacy Template consent that cannot be compared.",
          );
        } catch (error) {
          // Adopted consent cannot be recomputed under some host defaults; that agent still needs release.
          runtime.log(
            `Its settings cannot be compared with the Template consent: ${sanitizeTerminalText(formatErrorMessage(error))}`,
          );
        }
      }
      runtime.log(
        `Tool settings it keeps: ${sanitizeTerminalText(JSON.stringify(agent.tools ?? {}))}`,
      );
      runtime.log(
        "Release removes the Template consent record. The agent, workspace, sessions, plugins, " +
          "MCP servers, and automations stay, and its settings are no longer checked against the Template.",
      );

      const approved =
        opts.yes ||
        (process.stdin.isTTY &&
          process.stdout.isTTY &&
          (await promptYesNo(`Release agent ${agentId} from Template ownership?`)));
      if (!approved) {
        fail("Release not confirmed. Re-run with --yes to confirm, or interactively.");
        return;
      }

      const released = await runOpenClawStateWorkerOperation(
        context,
        (scope) =>
          scope.execute({
            type: "templateRelease.apply",
            input: {
              agentId,
              schemaVersion: record.schemaVersion,
              agentConfigDigest: record.agentConfigDigest,
            },
          }),
        {
          createAdmission: createSqliteWorkerWriteAdmission(context.admission.assertCurrent, [
            context.admission.databasePath,
          ]),
        },
      );
      if (!released) {
        fail(
          `Template ownership of ${agentId} changed during review. Nothing was released; re-run the command.`,
        );
        return;
      }
      runtime.log(`Released ${agentId}. It is now an ordinary agent; start the Gateway to use it.`);
    },
  });
}
