import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { ManagedWorktreeService } from "../agents/worktrees/service.js";
import { resolveDoctorContributionHealthChecks } from "../flows/doctor-health-contributions.js";
import {
  createDoctorHealthFlowContext,
  resolveDoctorHealthContributions,
  runDoctorHealthContributionList,
} from "../flows/doctor-health-contributions.test-support.js";
import { runDoctorLintChecks } from "../flows/doctor-lint-flow.js";
import * as gitExec from "../infra/git-exec.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import { withProjectCheckoutLifecycle } from "../projects/project-checkout.js";
import { cloneProjectCheckout } from "../projects/project-clone-runtime.js";
import {
  registerProjectRegistry,
  selectStoredProjectRegistry,
} from "../projects/project-registry.js";
import { registerClonedProjectRegistry } from "../projects/project-registry.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { collectProjectCloneShapeHealthFindings } from "./doctor-project-clone-shape.js";

const execFileAsync = promisify(execFile);
const checkId = "core/doctor/project-clone-shape";
const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

async function git(root: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", root, ...args])).stdout.trim();
}

describe("doctor project clone shape", () => {
  it.each(["full", "partial", "shallow", "both", "missing", "private"])(
    "inspects only registry clones and reports %s clone repair",
    async (shape) => {
      await withOpenClawTestState({ prefix: "openclaw-doctor-clones-" }, async (state) => {
        const source = state.path("source");
        await git(state.root, "init", "-b", "main", source);
        await git(source, "config", "user.name", "OpenClaw Test");
        await git(source, "config", "user.email", "test@example.invalid");
        for (const content of ["first", "second"]) {
          await fs.writeFile(path.join(source, "README.md"), `${content}\n`);
          await git(source, "add", ".");
          await git(source, "commit", "-m", content);
        }
        const origin = state.path("origin.git");
        await git(state.root, "clone", "--bare", source, origin);
        await git(origin, "config", "uploadpack.allowFilter", "true");
        const originUrl = pathToFileURL(origin).href;
        const ignored = state.path("workspace");
        await git(state.root, "clone", "--depth=1", "--filter=blob:none", originUrl, ignored);
        const cfg = { agents: { defaults: { workspace: ignored } } };
        const clone = state.path("project's clone");
        const partial = shape === "partial" || shape === "both";
        const shallow = shape === "shallow" || shape === "both" || shape === "private";
        await git(
          state.root,
          "clone",
          ...(partial ? ["--filter=blob:none"] : []),
          ...(shallow ? ["--depth=1"] : []),
          originUrl,
          clone,
        );
        let recordedUrl = originUrl;
        const authorization: (string | undefined)[] = [];
        if (shape === "private") {
          const server = createServer((request, response) => {
            authorization.push(request.headers.authorization);
            response.writeHead(401, { "WWW-Authenticate": 'Basic realm="synthetic"' });
            response.end();
          });
          recordedUrl = `${await listenLoopback(server)}/private.git`;
          onTestFinished(() => closeHttpServer(server));
        }
        if (shape === "both" || shape === "private") {
          await git(clone, "remote", "set-url", "origin", state.path("wrong.git"));
          await git(clone, "config", `url.${state.path("rewritten.git")}.insteadOf`, recordedUrl);
        }
        const project = await registerClonedProjectRegistry({
          path: clone,
          name: "Stored project",
          originUrl: recordedUrl,
        });
        await registerProjectRegistry({ path: ignored, name: "User checkout" });
        const configBefore = await fs.readFile(path.join(clone, ".git", "config"), "utf8");
        if (shape === "missing") {
          await fs.rm(clone, { recursive: true, force: true });
        }
        const checks = (await resolveDoctorContributionHealthChecks()).filter(
          (check) => check.id === checkId,
        );
        const detect = async () =>
          (
            await runDoctorLintChecks(
              { mode: "lint", cfg, runtime },
              { checks, includeAllChecks: true },
            )
          ).findings;
        const findings = await detect();
        if (shape === "full" || shape === "partial") {
          expect(findings).toEqual([]);
          return;
        }
        expect(findings).toHaveLength(1);
        const finding = findings[0]!;
        expect(finding).toMatchObject({
          severity: "warning",
          category: shape === "missing" ? "fix-now" : "recommended",
          path: clone,
        });
        expect(finding.message).toContain("Stored project");
        if (shape === "missing") {
          expect(finding.message).toContain("skipped");
          return;
        }
        expect(finding.message).not.toContain("repack");
        expect(await fs.readFile(path.join(clone, ".git", "config"), "utf8")).toBe(configBefore);
        expect(await git(clone, "rev-parse", "--is-shallow-repository")).toBe("true");

        const repair = () => collectProjectCloneShapeHealthFindings(cfg, { repair: true });
        if (shape === "private") {
          const result = await collectProjectCloneShapeHealthFindings(cfg, {
            repair: true,
            env: { ...state.env, GH_TOKEN: "synthetic-not-admitted" },
          });
          expect(result[0]?.message).toContain(
            "Doctor has no admitted Control UI/Gateway credential",
          );
          expect(authorization).toEqual([undefined]);
          expect(await git(clone, "rev-parse", "--is-shallow-repository")).toBe("true");
          expect(await fs.readFile(path.join(clone, ".git", "config"), "utf8")).toBe(configBefore);
          return;
        }
        if (shape === "shallow") {
          await withProjectCheckoutLifecycle(clone, {}, async () => {
            expect((await repair())[0]?.message).toContain("busy; skipped");
            expect(await git(clone, "rev-parse", "--is-shallow-repository")).toBe("true");
          });
          const foreignLock = path.join(clone, ".git", "shallow.lock");
          await fs.writeFile(foreignLock, "another fetch");
          expect((await repair())[0]?.message).toContain("unshallow failed");
          expect(await fs.readFile(foreignLock, "utf8")).toBe("another fetch");
          await fs.unlink(foreignLock);
          // A failed origin must remain retryable without losing local history.
          const savedOrigin = state.path("saved-origin.git");
          await fs.rename(origin, savedOrigin);
          expect((await repair())[0]?.message).toContain("unshallow failed");
          expect(await git(clone, "rev-parse", "--is-shallow-repository")).toBe("true");
          await git(state.root, "clone", "--bare", ignored, origin);
          expect((await repair())[0]?.message).toContain("still shallow");
          await fs.rm(origin, { recursive: true, force: true });
          await fs.rename(savedOrigin, origin);
        }
        const head = await git(clone, "rev-parse", "HEAD");
        const reflog = await fs.readFile(path.join(clone, ".git", "logs", "HEAD"), "utf8");
        if (shape === "both") {
          await runDoctorHealthContributionList(
            createDoctorHealthFlowContext({ cfg, options: { repair: true } }),
            resolveDoctorHealthContributions().filter((c) => c.id === "doctor:project-clone-shape"),
          );
        }
        const result = shape === "both" ? [] : await repair();
        if (shape !== "both") {
          expect(result).toEqual([expect.objectContaining({ severity: "info" })]);
          expect(result[0]?.message).toContain("unshallowed");
        }
        expect(await git(clone, "rev-parse", "--is-shallow-repository")).toBe("false");
        expect(await git(clone, "rev-list", "--count", "HEAD")).toBe("2");
        expect(await git(clone, "rev-parse", "HEAD")).toBe(head);
        expect(await fs.readFile(path.join(clone, ".git", "logs", "HEAD"), "utf8")).toBe(reflog);
        expect(await git(clone, "config", "remote.origin.partialclonefilter")).toBe("blob:none");
        expect(await git(clone, "config", "remote.origin.promisor")).toBe("true");
        expect(await detect()).toEqual([]);
        expect(await repair()).toEqual([]);
        expect(await git(ignored, "rev-parse", "--is-shallow-repository")).toBe("true");
        expect(await git(ignored, "config", "remote.origin.partialclonefilter")).toBe("blob:none");
        if (shape === "both") {
          expect(await fs.readFile(path.join(clone, ".git", "config"), "utf8")).toBe(configBefore);
          await git(clone, "remote", "set-url", "origin", originUrl);
          await git(clone, "config", "--unset", `url.${state.path("rewritten.git")}.insteadOf`);
          const fresh = state.path("fresh");
          await cloneProjectCheckout({ url: originUrl, target: fresh });
          expect(await git(fresh, "rev-list", "--count", "HEAD")).toBe("2");
          expect(await git(fresh, "rev-parse", "--is-shallow-repository")).toBe("false");
          const linked = state.path("agent-linked");
          await git(clone, "worktree", "add", "--detach", linked);
          await git(linked, "fetch", "--depth", "1", "origin");
          expect(await git(clone, "rev-parse", "--is-shallow-repository")).toBe("true");
          const selected = (await selectStoredProjectRegistry(project.id))!;
          const service = new ManagedWorktreeService({
            env: state.env,
            getConfig: () => ({ worktreeAcceleration: false }),
          });
          const repairGate = createDeferred();
          const repairStarted = createDeferred();
          const execute = gitExec.executeGitCommand;
          using commands = vi
            .spyOn(gitExec, "executeGitCommand")
            .mockImplementation(async (...args) => {
              if (args[1].includes("--unshallow")) {
                repairStarted.resolve();
                await repairGate.promise;
              }
              return execute(...args);
            });
          const logs = createWarnLogCapture("worktree-history");
          const creation = service.create({
            repoRoot: linked,
            name: "after-depth-fetch",
            baseRef: "HEAD",
            withSource: (run) => selected.withCurrent((current) => run(current)),
          });
          try {
            const child = await awaitGateBeforeSettlement(
              creation,
              repairStarted.promise,
              "Worktree creation started unshallow",
            );
            expect(commands.mock.calls.some(([, args]) => args.includes("--unshallow"))).toBe(
              false,
            );
            expect(await git(child.path, "rev-list", "--count", "HEAD")).toBe("1");
            expect(await logs.findText("openclaw doctor --fix")).toContain(clone);
          } finally {
            repairGate.resolve();
            await creation;
            logs.cleanup();
          }
          expect((await detect())[0]?.message).toContain("shallow history");
          expect((await repair())[0]?.message).toContain("unshallowed");
          expect(await git(clone, "rev-parse", "--is-shallow-repository")).toBe("false");
          await git(ignored, "init", "--separate-git-dir", state.path("operator.git"));
          const ordinary = await service.create({
            repoRoot: ignored,
            name: "operator",
            baseRef: "HEAD",
          });
          expect(await git(ordinary.path, "rev-parse", "--is-shallow-repository")).toBe("true");
        }
      });
    },
  );
});
