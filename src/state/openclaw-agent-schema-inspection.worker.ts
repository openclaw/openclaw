import { once } from "node:events";
import { formatErrorMessage } from "../infra/errors.js";
import { tryInspectSqliteReadOnlyInProcess } from "../infra/sqlite-readonly-inspection.js";
import {
  inspectAgentDatabaseSchema,
  type AgentSchemaInspectionInput,
} from "./openclaw-agent-schema-inspection.js";

if (!process.send || !process.disconnect) {
  throw new Error("Agent schema inspection requires parent IPC.");
}
const send = process.send.bind(process);
const disconnect = process.disconnect.bind(process);
// SAFETY: Only the schema preflight owner sends this private IPC input.
const [input] = (await once(process, "message")) as [AgentSchemaInspectionInput];
try {
  const inspected = tryInspectSqliteReadOnlyInProcess(input.pathname, (database) =>
    inspectAgentDatabaseSchema(database, input),
  );
  send({ ok: true, inspection: inspected?.value ?? null }, disconnect);
} catch (error) {
  send({ ok: false, message: formatErrorMessage(error) }, disconnect);
}
