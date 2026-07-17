import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { deleteClawMcpServerRef, installClawMcpServers, planClawMcpServerRemoval } from "./mcp.js";
import { parseClawManifest } from "./schema.js";
import type { ClawSourceIdentity } from "./types.js";

afterEach(() => closeOpenClawStateDatabaseForTest());

async function fixture(agentId = "worker", root?: string) {
  const packageRoot = root ?? (await mkdtemp(join(tmpdir(), "openclaw-claw-mcp-")));
  const parsed = parseClawManifest({
    schemaVersion: 1,
    agent: { id: agentId },
    mcpServers: {
      docs: {
        command: "uvx",
        args: ["docs-mcp"],
        env: { DOCS_TOKEN: "${DOCS_TOKEN}" },
      },
      linear: {
        url: "https://mcp.linear.app/mcp",
        transport: "streamable-http",
        auth: "oauth",
      },
    },
  });
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.diagnostics));
  }
  const source: ClawSourceIdentity = {
    kind: "package",
    name: `@acme/${agentId}`,
    version: "1.0.0",
    packageRoot,
    manifestPath: join(packageRoot, "openclaw.claw.json"),
    integrityKind: "artifact",
    integrity: "sha256:manifest",
    byteLength: 100,
  };
  const plan = await buildClawAddPlan({
    manifest: parsed.manifest,
    source,
    context: { workspace: join(packageRoot, "workspace") },
  });
  return { root: packageRoot, plan, env: { OPENCLAW_STATE_DIR: join(packageRoot, "state") } };
}

function listedMcpServers(mcpServers: Record<string, Record<string, unknown>> = {}) {
  return { ok: true as const, path: "config", config: {}, mcpServers };
}

describe("installClawMcpServers", () => {
  it("uses create-only config writes and stores digest-only ownership", async () => {
    const current = await fixture();
    const setMcpServer = vi
      .fn()
      .mockResolvedValue({ ok: true, path: "config", config: {}, mcpServers: {} });

    const refs = await installClawMcpServers(current.plan, {
      env: current.env,
      setMcpServer,
      listMcpServers: vi.fn().mockResolvedValue(listedMcpServers()),
      nowMs: 42,
    });

    expect(setMcpServer).toHaveBeenNthCalledWith(1, {
      name: "docs",
      server: {
        command: "uvx",
        args: ["docs-mcp"],
        env: { DOCS_TOKEN: "${DOCS_TOKEN}" },
      },
      createOnly: true,
    });
    expect(setMcpServer).toHaveBeenNthCalledWith(2, {
      name: "linear",
      server: {
        url: "https://mcp.linear.app/mcp",
        transport: "streamable-http",
        auth: "oauth",
      },
      createOnly: true,
    });
    expect(refs).toMatchObject([
      {
        schemaVersion: "openclaw.clawMcpServerRef.v1",
        agentId: "worker",
        name: "docs",
        configDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        ownership: "claw-installed",
        status: "complete",
      },
      {
        schemaVersion: "openclaw.clawMcpServerRef.v1",
        agentId: "worker",
        name: "linear",
        configDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        status: "complete",
      },
    ]);
    expect(JSON.stringify(refs)).not.toContain("DOCS_TOKEN");
  });

  it("rejects a conflicting existing server without claiming ownership", async () => {
    const current = await fixture();
    await expect(
      installClawMcpServers(current.plan, {
        env: current.env,
        listMcpServers: vi
          .fn()
          .mockResolvedValue(listedMcpServers({ docs: { command: "different" } })),
      }),
    ).rejects.toMatchObject({
      code: "mcp_config_conflict",
      mcpServers: [],
    });
  });

  it("reuses an exact pre-existing server as independently owned", async () => {
    const current = await fixture();
    const setMcpServer = vi.fn();
    const refs = await installClawMcpServers(current.plan, {
      env: current.env,
      setMcpServer,
      listMcpServers: vi.fn().mockResolvedValue(
        listedMcpServers({
          docs: {
            command: "uvx",
            args: ["docs-mcp"],
            env: { DOCS_TOKEN: "${DOCS_TOKEN}" },
          },
          linear: {
            url: "https://mcp.linear.app/mcp",
            transport: "streamable-http",
            auth: "oauth",
          },
        }),
      ),
    });

    expect(setMcpServer).not.toHaveBeenCalled();
    expect(refs).toMatchObject([
      { name: "docs", ownership: "independently-owned", status: "complete" },
      { name: "linear", ownership: "independently-owned", status: "complete" },
    ]);
    expect(planClawMcpServerRemoval(refs[0]!, { env: current.env })).toBe("release");
  });

  it("allows another Claw to share an exact Claw-created server", async () => {
    const first = await fixture("worker");
    const firstRefs = await installClawMcpServers(first.plan, {
      env: first.env,
      setMcpServer: vi.fn().mockResolvedValue(listedMcpServers()),
      listMcpServers: vi.fn().mockResolvedValue(listedMcpServers()),
    });
    const second = await fixture("analyst", first.root);
    const setMcpServer = vi.fn();
    const refs = await installClawMcpServers(second.plan, {
      env: second.env,
      setMcpServer,
      listMcpServers: vi.fn().mockResolvedValue(
        listedMcpServers({
          docs: {
            command: "uvx",
            args: ["docs-mcp"],
            env: { DOCS_TOKEN: "${DOCS_TOKEN}" },
          },
          linear: {
            url: "https://mcp.linear.app/mcp",
            transport: "streamable-http",
            auth: "oauth",
          },
        }),
      ),
    });

    expect(setMcpServer).not.toHaveBeenCalled();
    expect(refs).toMatchObject([
      { agentId: "analyst", name: "docs", ownership: "claw-installed" },
      { agentId: "analyst", name: "linear", ownership: "claw-installed" },
    ]);
    const firstDocs = firstRefs[0]!;
    expect(planClawMcpServerRemoval(firstDocs, { env: first.env })).toBe("release");
    deleteClawMcpServerRef("analyst", "docs", { env: first.env });
    expect(planClawMcpServerRemoval(firstDocs, { env: first.env })).toBe("remove");
  });

  it("leaves ownership pending when a config write throws", async () => {
    const current = await fixture();
    await expect(
      installClawMcpServers(current.plan, {
        env: current.env,
        setMcpServer: vi.fn().mockRejectedValue(new Error("write result unknown")),
        listMcpServers: vi.fn().mockResolvedValue(listedMcpServers()),
      }),
    ).rejects.toMatchObject({
      code: "mcp_install_uncertain",
      mcpServers: [{ name: "docs", status: "pending" }],
    });
  });

  it("reconciles an ambiguous write from source config on retry", async () => {
    const current = await fixture();
    const setMcpServer = vi
      .fn()
      .mockRejectedValueOnce(new Error("write result unknown"))
      .mockResolvedValue({ ok: true, path: "config", config: {}, mcpServers: {} });
    await expect(
      installClawMcpServers(current.plan, {
        env: current.env,
        setMcpServer,
        listMcpServers: vi.fn().mockResolvedValue(listedMcpServers()),
      }),
    ).rejects.toMatchObject({ code: "mcp_install_uncertain" });

    const refs = await installClawMcpServers(current.plan, {
      env: current.env,
      setMcpServer,
      listMcpServers: vi.fn().mockResolvedValue({
        ok: true,
        path: "config",
        config: {},
        mcpServers: {
          docs: {
            command: "uvx",
            args: ["docs-mcp"],
            env: { DOCS_TOKEN: "${DOCS_TOKEN}" },
          },
        },
      }),
    });

    expect(setMcpServer).toHaveBeenCalledTimes(2);
    expect(refs[0]).toMatchObject({ name: "docs", status: "complete" });
    expect(refs[1]).toMatchObject({ name: "linear", status: "complete" });
  });
});
