import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  applyExtractedSkillRoot,
  installExtractedSkillRoot,
} from "../../skills/lifecycle/archive-install.js";
import { defaultSkillUploadStore } from "../../skills/lifecycle/upload-store.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import type { GatewayClient } from "./client-types.js";

const hooks = vi.hoisted(() => ({
  scan: vi.fn(async () => undefined),
  beforeMove: undefined as ((from: string, to: string) => Promise<void>) | undefined,
}));
vi.mock("../../plugins/install-security-scan.js", () => ({
  evaluateSkillInstallPolicy: hooks.scan,
}));
vi.mock("@openclaw/fs-safe/atomic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/fs-safe/atomic")>();
  return {
    ...actual,
    movePathWithCopyFallback: async (
      options: Parameters<typeof actual.movePathWithCopyFallback>[0],
    ) => {
      await hooks.beforeMove?.(options.from, options.to);
      return actual.movePathWithCopyFallback(options);
    },
  };
});

const client: GatewayClient = {
  connect: {
    minProtocol: 1,
    maxProtocol: 1,
    role: "operator",
    scopes: ["operator.admin"],
    client: { id: "test", mode: "test", platform: "test", version: "1" },
  },
};
let state: OpenClawTestState;
let config: OpenClawConfig;
let gatewayWorkspaceDir: string;
let serial = 0;
const context = createDirectChatContext({
  getRuntimeConfig: () => config,
  getCommittedRuntimeConfig: () => config,
});
function setUploads(enabled = true) {
  config = {
    agents: { entries: { main: { workspace: gatewayWorkspaceDir } } },
    gateway: { uploads: { enabled } },
    skills: { install: { allowUploadedArchives: true } },
  };
}
async function dispatch(uploadId: string, slug: string, force = false, caller = client) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: {
      type: "req",
      id: String(++serial),
      method: "skills.install",
      params: { source: "upload", agentId: "main", uploadId, slug, force },
    },
    client: caller,
    context,
    isWebchatConnect: () => false,
    respond,
  });
  return respond;
}
async function prepareUpload(slug: string, force = false) {
  const zip = new JSZip();
  zip.file(
    "SKILL.md",
    "---\nname: Upload proof\ndescription: Publication proof\n---\nNew client bytes.\n",
  );
  const archive = await zip.generateAsync({ type: "nodebuffer" });
  const { uploadId } = await defaultSkillUploadStore.begin({
    kind: "skill-archive",
    slug,
    sizeBytes: archive.length,
    force,
  });
  await defaultSkillUploadStore.chunk({
    uploadId,
    offset: 0,
    dataBase64: archive.toString("base64"),
  });
  await defaultSkillUploadStore.commit({ uploadId });
  return uploadId;
}

beforeAll(async () => {
  state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-skill-install-upload-policy-",
  });
  gatewayWorkspaceDir = state.workspaceDir;
  setUploads();
  await state.writeConfig(config);
});
afterAll(async () => {
  await state.cleanup();
});
beforeEach(() => {
  gatewayWorkspaceDir = state.workspaceDir;
  setUploads();
  hooks.scan.mockReset();
  hooks.scan.mockResolvedValue(undefined);
  hooks.beforeMove = undefined;
});

describe("uploaded archive policy at final installation publication", () => {
  it.each(["scan", "publish", "replace", "workspace-host"] as const)(
    "rejects hot-disabled uploads at %s and releases the install lease for retry",
    async (phase) => {
      const slug = "late-install-" + ++serial;
      const force = phase === "replace";
      const uploadId = await prepareUpload(slug, force);
      const workspaceDir = phase === "workspace-host" ? state.path(slug) : state.workspaceDir;
      const targetDir = path.join(workspaceDir, "skills", slug);
      if (force) {
        await fs.mkdir(targetDir, { recursive: true });
        await fs.writeFile(path.join(targetDir, "SKILL.md"), "Original skill.\n");
      }
      const unavailable = async (): Promise<never> => {
        throw new Error("file bridge must not install a skill");
      };
      // Exercises the registered workspace adapter and native host owner, not a network transport.
      if (phase === "workspace-host") {
        gatewayWorkspaceDir = state.path(slug + "-gateway");
        setUploads();
      }
      const releaseWorkspace =
        phase === "workspace-host"
          ? registerAgentWorkspaceAccess(gatewayWorkspaceDir, {
              loadSkills: vi.fn(),
              applySkillRoot: (params) => applyExtractedSkillRoot({ ...params, workspaceDir }),
              bridge: { readFile: unavailable, writeFile: unavailable, stat: unavailable },
            })
          : undefined;
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const pause = async () => {
        entered.resolve();
        await release.promise;
      };
      if (phase === "scan") {
        hooks.scan.mockImplementationOnce(async () => {
          await pause();
          return undefined;
        });
      } else {
        hooks.beforeMove = async (from, to) => {
          if (from.includes(".openclaw-install-stage-") && path.basename(to) === slug) {
            await pause();
          }
        };
      }
      const pending = dispatch(uploadId, slug, force);
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("install settled before the publication checkpoint");
          }),
        ]);
        setUploads(false);
        release.resolve();
        const respond = await pending;
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: "FORBIDDEN",
            details: { code: "UPLOADS_DISABLED" },
          }),
        );
        if (force) {
          await expect(fs.readFile(path.join(targetDir, "SKILL.md"), "utf8")).resolves.toBe(
            "Original skill.\n",
          );
        } else {
          await expect(fs.stat(targetDir)).rejects.toMatchObject({ code: "ENOENT" });
        }
        // Reusing the same committed archive proves refusal did not consume it or retain its lease.
        hooks.beforeMove = undefined;
        setUploads();
        expect(await dispatch(uploadId, slug, force)).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ ok: true }),
          undefined,
        );
        await expect(fs.readFile(path.join(targetDir, "SKILL.md"), "utf8")).resolves.toContain(
          "New client bytes.",
        );
        await expect(
          defaultSkillUploadStore.withCommittedUpload(uploadId, async () => undefined),
        ).rejects.toThrow("upload not found");
      } finally {
        release.resolve();
        try {
          await pending;
        } finally {
          releaseWorkspace?.();
        }
      }
    },
  );

  it("keeps trusted internal archive installs and ordinary local installs available", async () => {
    const slug = "internal-install-" + ++serial;
    const uploadId = await prepareUpload(slug);
    setUploads(false);
    const internal = createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] });
    expect(await dispatch(uploadId, slug, false, internal)).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: true }),
      undefined,
    );
    const source = state.path("local-source");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "SKILL.md"), "Existing local skill.\n");
    const local = await installExtractedSkillRoot({
      workspaceDir: state.workspaceDir,
      slug: "local-install",
      extractedRoot: source,
      mode: "install",
      policy: { config, origin: { type: "path", spec: source } },
    });
    expect(local).toMatchObject({ ok: true });
  });
});
