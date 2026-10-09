import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { loadOpenRouterModelCapabilities } from "../agents/embedded-agent-runner/openrouter-model-capabilities.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";

it("joins an accepted catalog refresh across the close prelude before plugin-state retirement", async ({
  signal,
}) => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-plugin-state-close");
  const fetching = createDeferred();
  const releaseResponse = createDeferred();
  const prelude = createDeferred();
  const caller = new AsyncWorkScope();
  let closing: Promise<void> | undefined;
  let loading: Promise<void> | undefined;
  try {
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    const kernel = expectDefined(fixture.kernels.get(port), "Gateway kernel");
    const database = openOpenClawStateDatabase({ env: fixture.state.env }).db;
    vi.stubGlobal("fetch", async () => {
      fetching.resolve();
      await releaseResponse.promise;
      return Response.json({ data: [{ id: "synthetic/close-proof", name: "Close proof" }] });
    });
    loading = caller.run(() => loadOpenRouterModelCapabilities("synthetic/close-proof"));
    await withinTest(
      awaitGateBeforeSettlement(fetching.promise, loading, "Catalog did not enter its fetch"),
      signal,
    );
    kernel.scheduler.signal.addEventListener(
      "abort",
      () => {
        caller.beginClose();
        prelude.resolve();
      },
      { once: true },
    );
    let closed = false;
    closing = server.close({ reason: "plugin state close regression" }).then(() => {
      closed = true;
    });
    await withinTest(
      awaitGateBeforeSettlement(prelude.promise, closing, "Gateway skipped its close prelude"),
      signal,
    );
    expect(caller.signal.aborted).toBe(true);
    expect(closed).toBe(false);
    expect(database.isOpen).toBe(true);
    releaseResponse.resolve();
    await withinTest(Promise.all([loading, closing]), signal);
    expect(database.isOpen).toBe(false);
    const persisted = new DatabaseSync(resolveOpenClawStateSqlitePath(fixture.state.env), {
      readOnly: true,
    });
    try {
      const row = persisted
        .prepare(
          "SELECT value_json FROM plugin_state_entries WHERE plugin_id = ? AND namespace = ? AND entry_key = ?",
        )
        .get("core:openrouter-model-capabilities", "models.v4", "synthetic/close-proof");
      expect(row && JSON.parse(String(row.value_json))).toMatchObject({ name: "Close proof" });
    } finally {
      persisted.close();
    }
  } finally {
    releaseResponse.resolve();
    await Promise.allSettled([loading, closing]);
    vi.unstubAllGlobals();
    await caller.drain();
    await fixture.cleanup();
  }
});
