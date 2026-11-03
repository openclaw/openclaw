// Continuation (karmaterminal): durable continuation rows recover in a new process only from the state dir that owns them.
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const temporary = useAutoCleanupTempDirTracker(afterAll);
const child = fileURLToPath(
  new URL("./server-restart-sentinel.new-process.child.test-support.ts", import.meta.url),
);
const LIFETIME_TIMEOUT_MS = 150_000;

type Row = { id: string; kind: string; deliveryStartedAt: number | null; retryCount: number };
type Lifetime = {
  ids?: string[];
  pending?: Row[];
  before?: Row[];
  after?: Row[];
  capturedStateDir?: string;
  events?: Array<{ text: string; sessionKey: string; contextKey?: string; sessionId?: string }>;
  dispatches?: Array<{ sessionKey: string; messageSid?: string }>;
  queued?: Record<string, Array<Record<string, unknown>>>;
  logs?: string[];
  output: string;
};

/** One gateway lifetime in a fresh Node process, run as production (no test-mode env). */
async function lifetime(
  stateDir: string,
  mode: "seed" | "recover",
  args: Record<string, unknown> = {},
  expectCrash = false,
): Promise<Lifetime> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    NO_COLOR: "1",
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith("VITEST") || key === "NODE_ENV") {
      delete env[key];
    }
  }
  const result = await runNodeScript(
    ["--import", "tsx", child, mode, JSON.stringify(args)],
    env,
    LIFETIME_TIMEOUT_MS,
    { requireProcessTreeExit: true },
  );
  const output = `${result.stdout}\n${result.stderr}`;
  if (expectCrash) {
    expect(result.status, output).not.toBe(0);
  } else {
    expect(result.error, output).toBeUndefined();
    expect(result.status, output).toBe(0);
  }
  const report = result.stdout.split("\n").findLast((line) => line.startsWith('{"mode"'));
  expect(report, output).toBeDefined();
  return { ...(JSON.parse(report!) as Omit<Lifetime, "output">), output };
}

/** Raw queue rows, read without any owner code; null when the state database was never created. */
function storedRows(stateDir: string) {
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  if (!existsSync(databasePath)) {
    return null;
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database
      .prepare("SELECT id, status FROM delivery_queue_entries WHERE queue_name = 'session'")
      .all() as Array<{ id: string; status: string }>;
    return Object.fromEntries(rows.map((row) => [row.id, row.status]));
  } finally {
    database.close();
  }
}

const ids = (rows: Row[] | undefined) => rows?.map((row) => row.id);

describe("fork-only: recipient-bound continuation rows across process lifetimes", () => {
  it(
    "ownership loss: a revoked recipient's row retires without an event; a current one is queued for adoption bound to its owning dir, not process.env's",
    { timeout: 2 * LIFETIME_TIMEOUT_MS },
    async () => {
      const stateDir = temporary.make("openclaw-restart-authority-");
      const environment = temporary.make("openclaw-restart-authority-env-");
      const [revokedId, keptId] = (
        await lifetime(stateDir, "seed", {
          rows: [
            { kind: "authority", revision: 1, sessionKey: "agent:main:revoked", revoke: true },
            { kind: "authority", revision: 2, sessionKey: "agent:main:kept", revoke: false },
          ],
        })
      ).ids!;
      const recovered = await lifetime(environment, "recover", {
        captureStateDir: stateDir,
        peekSessionKeys: ["agent:main:revoked", "agent:main:kept"],
      });
      expect(recovered.output).toContain(
        `[continuation:return-refused] stage=replay reason=recipient-authority-changed session=agent:main:revoked deliveryId=${revokedId}`,
      );
      expect(recovered.queued?.["agent:main:revoked"]).toEqual([]);
      expect(recovered.queued?.["agent:main:kept"]).toEqual([
        expect.objectContaining({
          text: "delegate result 2",
          sessionDeliveryAckId: keptId,
          sessionDeliveryAckStateDir: stateDir,
        }),
      ]);
      // The kept row stays pending until a prompt adopts its in-memory event.
      expect(ids(recovered.after)).toEqual([keptId]);
      // Refused, not recovered: the revoked row is retired as failed and never reported delivered.
      expect(recovered.logs).toEqual([
        `warn: Session delivery: dead-letter decision for entry ${revokedId}: continuation return refused: recipient-authority-changed`,
        `warn: Session delivery: entry ${revokedId} was dead-lettered and moved to failed`,
      ]);
      expect(storedRows(stateDir)).toEqual({ [keptId!]: "pending" });
      expect(storedRows(environment)).toBeNull();
    },
  );
});
