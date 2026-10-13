import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "./openclaw-agent-db-lifecycle.js";
import {
  createAgentCreationWitnessFixture as fixture,
  createAgentCreationWitnessSource as source,
} from "./openclaw-agent-execution.creation-fixture.test-support.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";

it("keeps admitted creator reads and writes on the original file after its alias changes", async () => {
  const options = fixture();
  const originalDirectory = path.join(options.env.OPENCLAW_STATE_DIR, "original");
  const successorDirectory = path.join(options.env.OPENCLAW_STATE_DIR, "successor");
  const alias = path.join(options.env.OPENCLAW_STATE_DIR, "selected");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  fs.mkdirSync(originalDirectory);
  fs.mkdirSync(successorDirectory);
  fs.symlinkSync(originalDirectory, alias, linkType);
  const aliased = { ...options, path: path.join(alias, "agent.sqlite") };
  const successor = captureOpenClawAgentDatabaseExecution({
    ...options,
    path: path.join(successorDirectory, "agent.sqlite"),
  });
  const creator = captureOpenClawAgentDatabaseExecution(aliased, {
    expectedCreationIdentity: readDatabasePathIdentitySync(aliased.path),
  });
  const canonical = captureOpenClawAgentDatabaseExecution({
    ...options,
    path: path.join(originalDirectory, "agent.sqlite"),
  });
  const sessionKey = "agent:main:retarget-proof";
  const readEntry = (execution: typeof creator) =>
    execution.runExisting(source(), (scope) =>
      scope.execute({ type: "session.entry.read", input: { sessionKeys: [sessionKey] } }),
    );
  try {
    await successor.prepare(source());
    await successor.runExisting(source(), (scope) =>
      scope.execute({
        type: "session.transcript.initialize",
        input: { sessionKey, sessionId: "successor-session" },
      }),
    );
    await creator.prepare(source());
    const receipt = creator.fileIdentity;
    expect(receipt).toBeDefined();
    expect(receipt?.physicalIdentity).not.toBe(successor.fileIdentity?.physicalIdentity);
    fs.unlinkSync(alias);
    fs.symlinkSync(successorDirectory, alias, linkType);
    await expect(
      creator.runExisting(source(), (scope) =>
        scope.execute({
          type: "session.transcript.initialize",
          input: { sessionKey, sessionId: "original-session" },
        }),
      ),
    ).resolves.toMatchObject({
      kind: "session-transcript-initialized",
      sessionKey,
      placeholder: { sessionId: "original-session" },
    });
    for (const execution of [creator, canonical]) {
      await expect(readEntry(execution)).resolves.toMatchObject({
        entries: [{ sessionKey, entry: { sessionId: "original-session" } }],
      });
    }
    expect(canonical.fileIdentity).toEqual(receipt);
    expect(creator.fileIdentity).toEqual(receipt);
    await closeOpenClawAgentDatabaseByPathAsync(aliased.path, options.agentId);
    expect(() => creator.assertCurrent()).toThrow(/closed/);
    expect(() => canonical.assertCurrent()).toThrow(/closed/);
    await expect(readEntry(successor)).resolves.toMatchObject({
      entries: [{ sessionKey, entry: { sessionId: "successor-session" } }],
    });
  } finally {
    await Promise.allSettled([creator.release(), canonical.release(), successor.release()]);
  }
});
