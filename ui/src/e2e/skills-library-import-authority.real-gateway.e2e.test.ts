import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ViteDevServer } from "vite";
import { expect, it } from "vitest";
import type {
  SkillsLibraryListResult,
  SkillsLibraryReadResult,
  SkillsLibraryReceipt,
} from "../../../packages/gateway-protocol/src/schema/skill-library.ts";
import type { OpenClawConfig } from "../../../src/config/types.ts";
import type { GatewayClient } from "../../../src/gateway/client.ts";
import { resolveConfigRestartRequirement } from "../../../src/gateway/config-reload-plan.ts";
import { startGatewayServer } from "../../../src/gateway/server.ts";
import { loadOrCreateDeviceIdentity } from "../../../src/infra/device-identity.ts";
import {
  ensureCanonicalUserProfileForEmail,
  setCanonicalUserProfileDisplayName,
  setCanonicalUserProfileRole,
} from "../../../src/state/user-profile-writes.ts";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { acquireGatewayTestClient } from "../../../test/helpers/gateway-client.ts";
import { createLoopbackTlsFixture } from "../../../test/helpers/loopback-tls.test-support.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import {
  prepareStablePackage,
  proveStableSkillUpgrade,
} from "../../../test/helpers/skills-library-upgrade-proof.test-support.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { createGatewayProxy, gatewayProxyRoute } from "./gateway-proxy.test-support.ts";
import {
  createProofArchive,
  createSkillImportProofConfig,
  createProofPolicy,
  createProofSource,
  digest,
  proofBinary,
  proofExecutable,
  proofSkill,
  proofText,
  writePublicProof,
  type ImportProofReport,
} from "./skills-library-import-proof.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Real skill import authority, effects and stable survival",
  startServerBeforeBrowser: true,
});
const scopes = ["operator.admin", "operator.read", "operator.write"];
const emails = {
  writer: randomUUID() + "@example.test",
  reader: randomUUID() + "@example.test",
  redirect: randomUUID() + "@example.test",
  publication: randomUUID() + "@example.test",
};

type Actor = "writer" | "reader" | "redirect" | "publication";
type Source = Awaited<ReturnType<typeof createProofSource>>;
type Policy = Awaited<ReturnType<typeof createProofPolicy>>;
type Fixture = {
  state: OpenClawTestState;
  clients: Record<Actor, GatewayClient>;
  writerConnection: { hellos: number; closes: number };
  profiles: Record<Actor, string>;
  gatewayUrls: Record<Actor, string>;
  policy: Policy;
};

async function withGateway(
  origins: string[],
  source: Source,
  lifetime: { close?: () => Promise<void>; signal?: AbortSignal },
  run: (fixture: Fixture) => Promise<void>,
) {
  await withOpenClawTestState(
    {
      label: "skills-real-authority",
      env: {
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
      },
    },
    async (state) => {
      lifetime.signal?.throwIfAborted();
      const policy = await createProofPolicy(state.root);
      const seed = async (actor: Actor) => {
        const profile = await ensureCanonicalUserProfileForEmail(emails[actor]);
        await setCanonicalUserProfileDisplayName(profile.id, "Proof " + actor);
        await setCanonicalUserProfileRole(profile.id, actor === "reader" ? "reader" : "writer");
        return profile.id;
      };
      const [writerId, readerId, redirectId, publicationId] = await Promise.all([
        seed("writer"),
        seed("reader"),
        seed("redirect"),
        seed("publication"),
      ]);
      const profiles = {
        writer: writerId,
        reader: readerId,
        redirect: redirectId,
        publication: publicationId,
      };
      await state.writeConfig(
        createSkillImportProofConfig({
          workspaceDir: state.workspaceDir,
          uiOrigin: new URL(suite.server.baseUrl).origin,
          emails: Object.values(emails),
          scopes,
          origins,
          installPolicy: policy.config,
        }),
      );
      lifetime.signal?.throwIfAborted();
      const port = await getFreePort();
      const server = await startGatewayServer(port, {
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });
      const proxies: ViteDevServer[] = [];
      const writerConnection = { hellos: 0, closes: 0 };
      const connections = new Map<Actor, { client: GatewayClient; url: string }>();
      let closing: Promise<void> | undefined;
      const close = () =>
        (closing ??= runQaGatewayFixture(
          async () => {},
          ...[...connections.values()].map(
            ({ client }) =>
              () =>
                client.stopAndWait(),
          ),
          () => source.releaseAll(),
          () => policy.release(),
          ...proxies.map((proxy) => () => proxy.close()),
          () => server.close({ reason: "owned real skill proof complete" }),
        ));
      lifetime.close = close;
      try {
        await runQaGatewayFixture(async () => {
          for (const actor of ["writer", "reader", "redirect", "publication"] as const) {
            const proxy = await createGatewayProxy(state.root, {
              "/": gatewayProxyRoute(port, emails[actor]),
            });
            proxies.push(proxy);
            await proxy.listen();
            const address = proxy.httpServer?.address();
            if (!address || typeof address === "string") {
              throw new Error("Owned auth proxy unavailable");
            }
            const url = "ws://127.0.0.1:" + address.port;
            const client = await connect(
              url,
              state,
              actor,
              scopes,
              actor === "writer" ? writerConnection : undefined,
            );
            connections.set(actor, { client, url });
          }
          const writer = connections.get("writer");
          const reader = connections.get("reader");
          const redirect = connections.get("redirect");
          const publication = connections.get("publication");
          if (!writer || !reader || !redirect || !publication) {
            throw new Error("Owned profile connections incomplete");
          }
          const clients = {
            writer: writer.client,
            reader: reader.client,
            redirect: redirect.client,
            publication: publication.client,
          };
          const gatewayUrls = {
            writer: writer.url,
            reader: reader.url,
            redirect: redirect.url,
            publication: publication.url,
          };
          await clients.writer.request("exec.approvals.get", {});
          expect(
            await clients.reader.request("exec.approvals.get", {}).then(
              () => true,
              () => false,
            ),
          ).toBe(false);
          await run({ state, clients, profiles, gatewayUrls, policy, writerConnection });
        }, close);
      } finally {
        lifetime.close = undefined;
      }
    },
  );
}

async function connect(
  url: string,
  state: OpenClawTestState,
  name: string,
  requestedScopes: string[] = scopes,
  continuity?: { hellos: number; closes: number },
) {
  return acquireGatewayTestClient(
    {
      url,
      clientName: "test",
      mode: "test",
      scopes: requestedScopes,
      onHelloOk: () => {
        if (continuity) {
          continuity.hellos += 1;
        }
      },
      onClose: () => {
        if (continuity) {
          continuity.closes += 1;
        }
      },
      deviceIdentity: loadOrCreateDeviceIdentity({ path: state.path("clients/" + name + ".json") }),
    },
    {
      timeoutMs: 15000,
      timeoutMessage: "Owned profile authentication did not complete",
      closeMessage: "Owned profile connection closed before hello",
    },
  );
}
const list = (client: GatewayClient) =>
  client.request<SkillsLibraryListResult>("skills.library.list", {});
const importUrl = (client: GatewayClient, slug: string, url: string) =>
  client.request<SkillsLibraryReceipt>(
    "skills.library.import",
    { slug, source: { kind: "url", url, path: "skills/proof" } },
    { timeoutMs: 40000 },
  );
async function artifacts(state: OpenClawTestState) {
  const root = path.join(state.stateDir, "skill-library");
  let count = 0;
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/u.test(entry.name)) {
      continue;
    }
    count += (await fs.readdir(path.join(root, entry.name, "revisions")).catch(() => [])).length;
  }
  return count;
}
async function denied(client: GatewayClient, state: OpenClawTestState, slug: string, url: string) {
  const before = await artifacts(state);
  const accepted = await importUrl(client, slug, url).then(
    () => true,
    () => false,
  );
  expect(accepted).toBe(false);
  expect((await list(client)).entries.some((entry) => entry.slug === slug)).toBe(false);
  expect(await artifacts(state)).toBe(before);
}
async function revoke(fixture: Fixture, actor: "redirect" | "publication") {
  await setCanonicalUserProfileRole(fixture.profiles[actor], "reader");
  await expect
    .poll(() =>
      fixture.clients[actor].request("exec.approvals.get", {}).then(
        () => false,
        () => true,
      ),
    )
    .toBe(true);
}

suite.define(() => {
  let authorityReport: ImportProofReport | undefined;
  it.sequential("proves real candidate URL-import authority and effect boundaries", async (context) => {
    if (
      process.env.GITHUB_ACTIONS !== "true" ||
      !process.env.PROOF_HEAD ||
      !process.env.PROOF_PUBLIC_DIR
    ) {
      throw new Error(
        "Run the exact-head disposable skills-library-import-proof CI workflow; host runtime preparation is not supported",
      );
    }
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
      throw new Error("Proof requires normal TLS verification");
    }
    const observed = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const build: unknown = JSON.parse(await fs.readFile("dist/build-info.json", "utf8"));
    if (!isRecord(build) || typeof build.commit !== "string") {
      throw new Error("Canonical build identity missing");
    }
    expect(observed).toBe(process.env.PROOF_HEAD);
    expect(build.commit).toBe(observed);
    const publicDir = process.env.PROOF_PUBLIC_DIR;
    const report: ImportProofReport = {
      schemaVersion: 1,
      status: "running",
      authorityStatus: "running",
      upgradeStatus: "not-run",
      source: {
        expectedHead: process.env.PROOF_HEAD,
        observedHead: observed,
        tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim(),
        buildCommit: build.commit,
      },
      assertions: [],
    };
    authorityReport = report;
    await writePublicProof(publicDir, report);
    const lifetime: { close?: () => Promise<void>; signal?: AbortSignal } = {};
    await suite.runScenario(context, {
      close: async () => {
        await lifetime.close?.();
      },
      run: async (signal) => {
        lifetime.signal = signal;
        let stage = "strict-default";
        const progress = (next: string) => {
          signal.throwIfAborted();
          stage = next;
          console.info("Skill proof stage: " + next);
        };
        try {
          await withOpenClawTestState(
            { label: "skills-owned-https", applyEnv: false },
            async (raw) => {
              const tls = createLoopbackTlsFixture(
                raw.root,
                "DNS:localhost,IP:127.0.0.1,IP:127.0.0.2",
              );
              const trusted = getCACertificates("default");
              setDefaultCACertificates([...trusted, await fs.readFile(tls.caCert, "utf8")]);
              const sources: Source[] = [];
              await runQaGatewayFixture(
                async () => {
                  const archive = await createProofArchive();
                  const source = await createProofSource(tls, archive);
                  sources.push(source);
                  const other = await createProofSource(tls, archive);
                  sources.push(other);
                  const healthy = await fetch(source.alternateOrigin + "/fixture-health");
                  expect(healthy.ok).toBe(true);
                  await healthy.arrayBuffer();
                  report.assertions.push({
                    id: "owned-source-tls-and-alternate-host-reachable",
                    passed: true,
                  });
                  await withGateway([], source, lifetime, async (fixture) => {
                    await denied(
                      fixture.clients.writer,
                      fixture.state,
                      "strict-default",
                      source.origin + "/strict.zip",
                    );
                    expect(source.count("/strict.zip")).toBe(0);
                    report.assertions.push({
                      id: "strict-private-default",
                      passed: true,
                      receivedRequests: 0,
                    });
                  });
                  await withGateway([source.origin], source, lifetime, async (fixture) => {
                    progress("actual-browser-import");
                    await suite.withPage(
                      { viewport: { width: 1280, height: 900 }, colorScheme: "light" },
                      async ({ page }) => {
                        const url = new URL("settings/skills?agent=main", suite.server.baseUrl);
                        url.hash = new URLSearchParams({
                          gatewayUrl: fixture.gatewayUrls.writer,
                        }).toString();
                        await page.goto(url.href);
                        await page
                          .locator("openclaw-gateway-url-confirmation")
                          .getByRole("button", {
                            name: "Switch to " + new URL(fixture.gatewayUrls.writer).host,
                            exact: true,
                          })
                          .click();
                        await page
                          .getByRole("button", { name: "Import skill", exact: true })
                          .click();
                        const dialog = page.getByRole("dialog", {
                          name: "Import skill",
                          exact: true,
                        });
                        await dialog
                          .getByLabel("Skill name", { exact: true })
                          .fill("browser-proof");
                        await dialog
                          .locator('input[name="library-import-url"]')
                          .fill(source.origin + "/browser.zip");
                        await dialog.getByLabel(/Archive directory/u).fill("skills/proof");
                        await dialog
                          .getByRole("button", { name: "Import skill", exact: true })
                          .click();
                        await expect
                          .poll(async () =>
                            (await list(fixture.clients.writer)).entries.some(
                              (candidate) => candidate.slug === "browser-proof",
                            ),
                          )
                          .toBe(true);
                        const entry = (await list(fixture.clients.writer)).entries.find(
                          (candidate) => candidate.slug === "browser-proof",
                        );
                        if (!entry) {
                          throw new Error("Browser publication receipt missing");
                        }
                        expect(entry.ownerProfileId).toBe(fixture.profiles.writer);
                        const read = await fixture.clients.writer.request<SkillsLibraryReadResult>(
                          "skills.library.read",
                          { skillId: entry.skillId },
                        );
                        expect(digest(read.content)).toBe(digest(proofSkill));
                        const text = read.files.find(
                          (file) => file.path === "references/checklist.md",
                        );
                        const binary = read.files.find((file) => file.path === "assets/sample.bin");
                        const executable = read.files.find(
                          (file) => file.path === "scripts/task.sh",
                        );
                        expect(text && digest(text.content)).toBe(digest(proofText));
                        expect(binary && digest(Buffer.from(binary.content, "base64"))).toBe(
                          digest(proofBinary),
                        );
                        expect(executable?.executable).toBe(true);
                        expect(executable && digest(executable.content)).toBe(
                          digest(proofExecutable),
                        );
                        const expectedFiles = [
                          { path: "references/checklist.md", bytes: proofText, executable: false },
                          { path: "assets/sample.bin", bytes: proofBinary, executable: false },
                          { path: "scripts/task.sh", bytes: proofExecutable, executable: true },
                        ];
                        expect(
                          read.files.length === expectedFiles.length &&
                            expectedFiles.every((expected) =>
                              read.files.some(
                                (file) =>
                                  file.path === expected.path &&
                                  (file.executable === true) === expected.executable &&
                                  (expected.path === "assets/sample.bin"
                                    ? file.encoding === "base64"
                                    : (file.encoding ?? "utf8") === "utf8"),
                              ),
                            ),
                        ).toBe(true);
                        report.files = [
                          {
                            path: "SKILL.md",
                            sha256: digest(read.content),
                            sizeBytes: Buffer.byteLength(read.content),
                            executable: false,
                          },
                          ...expectedFiles.map((file) => ({
                            path: file.path,
                            sha256: digest(file.bytes),
                            sizeBytes: Buffer.byteLength(file.bytes),
                            executable: file.executable,
                          })),
                        ];
                        report.profileOwnership = {
                          expected: fixture.profiles.writer,
                          observed: entry.ownerProfileId ?? "missing",
                        };
                        expect(source.count("/browser.zip")).toBe(1);
                        expect(
                          (await fixture.policy.receipts()).some(
                            (value) =>
                              isRecord(value) &&
                              value.name === "browser-proof" &&
                              value.remote &&
                              value.decision === "allow",
                          ),
                        ).toBe(true);
                        report.assertions.push({
                          id: "browser-real-rpc-tls-publication-owner-and-bytes",
                          passed: true,
                          receivedRequests: source.count("/browser.zip"),
                        });
                        await expect.poll(() => dialog.count()).toBe(0);
                        await page
                          .getByRole("button", { name: /browser-proof A synthetic reusable/u })
                          .click();
                        const detail = page.getByRole("dialog");
                        const capture = async (name: "imported-skill" | "companion-detail") => {
                          const privateDir = process.env.PROOF_PRIVATE_DIR;
                          if (!privateDir) {
                            throw new Error("Owned private evidence directory missing");
                          }
                          await fs.mkdir(privateDir, { recursive: true, mode: 0o700 });
                          await fs.writeFile(
                            path.join(privateDir, name + ".viewport.private.png"),
                            await takeControlUiViewportScreenshot(page, detail, [detail]),
                          );
                          await fs.writeFile(
                            path.join(publicDir, name + ".png"),
                            await detail.screenshot({ animations: "disabled" }),
                          );
                        };
                        await expect
                          .poll(() => page.getByLabel("SKILL.md", { exact: true }).inputValue())
                          .toContain("# Transport proof");
                        await capture("imported-skill");
                        await page
                          .getByLabel("File", { exact: true })
                          .selectOption("references/checklist.md");
                        await expect
                          .poll(() =>
                            page
                              .getByLabel("references/checklist.md", { exact: true })
                              .inputValue(),
                          )
                          .toBe(proofText);
                        await capture("companion-detail");
                        report.screenshots = {
                          kind: "actual-dialog-crop",
                          viewport: { width: 1280, height: 900 },
                          theme: "light",
                          files: ["imported-skill.png", "companion-detail.png"],
                        };
                      },
                    );
                    progress("effect-boundaries");
                    await denied(
                      fixture.clients.reader,
                      fixture.state,
                      "readonly-proof",
                      source.origin + "/readonly.zip",
                    );
                    expect(source.count("/readonly.zip")).toBe(0);
                    await denied(
                      fixture.clients.writer,
                      fixture.state,
                      "wrong-port",
                      other.origin + "/wrong-port.zip",
                    );
                    expect(other.count("/wrong-port.zip")).toBe(0);
                    const hostConnections = source.connections();
                    await denied(
                      fixture.clients.writer,
                      fixture.state,
                      "wrong-host",
                      source.alternateOrigin + "/wrong-host.zip",
                    );
                    expect(source.count("/wrong-host.zip")).toBe(0);
                    expect(source.connections()).toBe(hostConnections);
                    const schemeConnections = source.connections();
                    await denied(
                      fixture.clients.writer,
                      fixture.state,
                      "wrong-scheme",
                      source.origin.replace("https:", "http:") + "/wrong-scheme.zip",
                    );
                    expect(source.count("/wrong-scheme.zip")).toBe(0);
                    expect(source.connections()).toBe(schemeConnections);
                    source.redirect("/other-origin", other.origin + "/redirect-target.zip");
                    await denied(
                      fixture.clients.writer,
                      fixture.state,
                      "wrong-redirect",
                      source.origin + "/other-origin",
                    );
                    expect(source.count("/other-origin")).toBe(1);
                    expect(other.count("/redirect-target.zip")).toBe(0);
                    await denied(
                      fixture.clients.writer,
                      fixture.state,
                      "policy-denied",
                      source.origin + "/policy-denied.zip",
                    );
                    expect(source.count("/policy-denied.zip")).toBe(1);
                    expect(
                      (await fixture.policy.receipts()).some(
                        (entry) =>
                          isRecord(entry) &&
                          entry.name === "policy-denied" &&
                          entry.remote &&
                          entry.decision === "block",
                      ),
                    ).toBe(true);
                    report.assertions.push(
                      { id: "readonly-before-request", passed: true, receivedRequests: 0 },
                      { id: "exact-origin-and-redirect-boundaries", passed: true, nextRequests: 0 },
                      {
                        id: "real-install-policy-denial-no-publication",
                        passed: true,
                        receivedRequests: 1,
                      },
                    );
                    progress("redirect-revocation");
                    const redirectArtifacts = await artifacts(fixture.state);
                    const hold = source.hold("/held-redirect", "/after-revocation.zip");
                    const pending = importUrl(
                      fixture.clients.redirect,
                      "redirect-revoked",
                      source.origin + "/held-redirect",
                    ).then(
                      () => true,
                      () => false,
                    );
                    await expect.poll(() => source.count("/held-redirect")).toBe(1);
                    await revoke(fixture, "redirect");
                    hold.release();
                    expect(await pending).toBe(false);
                    expect(source.count("/after-revocation.zip")).toBe(0);
                    expect(await artifacts(fixture.state)).toBe(redirectArtifacts);
                    const reader = await connect(
                      fixture.gatewayUrls.redirect,
                      fixture.state,
                      "redirect-after",
                      ["operator.read"],
                    );
                    try {
                      expect(
                        (await list(reader)).entries.some(
                          (entry) => entry.slug === "redirect-revoked",
                        ),
                      ).toBe(false);
                    } finally {
                      await reader.stopAndWait();
                    }
                    report.assertions.push({
                      id: "real-role-revocation-no-next-request",
                      passed: true,
                      receivedRequests: 1,
                      nextRequests: 0,
                    });
                    progress("publication-revocation");
                    const before = await artifacts(fixture.state);
                    const publication = importUrl(
                      fixture.clients.publication,
                      "publication-revoked",
                      source.origin + "/publication.zip",
                    ).then(
                      () => true,
                      () => false,
                    );
                    await expect.poll(() => fixture.policy.entered()).toBe(true);
                    expect(source.count("/publication.zip")).toBe(1);
                    await revoke(fixture, "publication");
                    await fixture.policy.release();
                    expect(await publication).toBe(false);
                    expect(await artifacts(fixture.state)).toBe(before);
                    const readOnly = await connect(
                      fixture.gatewayUrls.publication,
                      fixture.state,
                      "publication-after",
                      ["operator.read"],
                    );
                    try {
                      expect(
                        (await list(readOnly)).entries.some(
                          (entry) => entry.slug === "publication-revoked",
                        ),
                      ).toBe(false);
                    } finally {
                      await readOnly.stopAndWait();
                    }
                    report.assertions.push({
                      id: "real-role-revocation-after-policy-before-publication",
                      passed: true,
                      receivedRequests: source.count("/publication.zip"),
                    });
                    progress("origin-grant-revocation");
                    const originArtifacts = await artifacts(fixture.state);
                    const originHold = source.hold(
                      "/origin-held-redirect",
                      "/after-origin-revocation.zip",
                    );
                    const originPending = importUrl(
                      fixture.clients.writer,
                      "origin-revoked",
                      source.origin + "/origin-held-redirect",
                    ).then(
                      () => undefined,
                      (error: unknown) => error,
                    );
                    await expect
                      .poll(() => source.count("/origin-held-redirect"), { timeout: 10000 })
                      .toBe(1);
                    const beforeGrant = await fixture.clients.writer.request<{
                      hash: string;
                      config: OpenClawConfig;
                    }>("config.get", {});
                    expect(beforeGrant.config.skills?.library?.import?.allowedOrigins).toEqual([
                      source.origin,
                    ]);
                    const removedGrant = {
                      ...beforeGrant.config,
                      skills: {
                        ...beforeGrant.config.skills,
                        library: { import: { allowedOrigins: [] } },
                      },
                    };
                    expect(
                      resolveConfigRestartRequirement({
                        changedPaths: ["skills.library.import.allowedOrigins"],
                        previousConfig: beforeGrant.config,
                        nextConfig: removedGrant,
                      }).requiresRestart,
                    ).toBe(false);
                    const originalConnection = { ...fixture.writerConnection };
                    expect(originalConnection).toEqual({ hellos: 1, closes: 0 });
                    // The real config write owner awaits runtime application for this no-restart path.
                    await fixture.clients.writer.request("config.patch", {
                      baseHash: beforeGrant.hash,
                      raw: JSON.stringify({
                        skills: { library: { import: { allowedOrigins: [] } } },
                      }),
                      replacePaths: ["skills.library.import.allowedOrigins"],
                    });
                    const afterGrant = await fixture.clients.writer.request<{
                      hash: string;
                      config: OpenClawConfig;
                    }>("config.get", {});
                    expect(afterGrant.hash).not.toBe(beforeGrant.hash);
                    expect(afterGrant.config.skills?.library?.import?.allowedOrigins).toEqual([]);
                    expect(fixture.writerConnection).toEqual(originalConnection);
                    await fixture.clients.writer.request("exec.approvals.get", {});
                    originHold.release();
                    const originError = await originPending;
                    expect(originError).toBeInstanceOf(Error);
                    expect(originError instanceof Error ? originError.message : "").toContain(
                      "network policy changed",
                    );
                    expect(source.count("/after-origin-revocation.zip")).toBe(0);
                    expect(await artifacts(fixture.state)).toBe(originArtifacts);
                    expect(
                      (await list(fixture.clients.writer)).entries.some(
                        (entry) => entry.slug === "origin-revoked",
                      ),
                    ).toBe(false);
                    await fixture.clients.writer.request("exec.approvals.get", {});
                    expect(fixture.writerConnection).toEqual(originalConnection);
                    report.assertions.push({
                      id: "live-origin-grant-revocation-same-connection",
                      passed: true,
                      receivedRequests: 1,
                      nextRequests: 0,
                      configVersions: { before: beforeGrant.hash, after: afterGrant.hash },
                      connectionStable: true,
                    });
                  });
                },
                () => sources[0]?.close(),
                () => sources[1]?.close(),
                () => setDefaultCACertificates(trusted),
              );
            },
          );
          report.cleanup = {
            scope: "candidate-authority",
            gatewaysAndClientsStopped: true,
            sourcesClosed: true,
            testStateReleased: true,
            testCaTrustRestored: true,
          };
          report.authorityStatus = "passed";
        } catch {
          report.authorityStatus = "failed";
          report.failedStage = stage;
          throw new Error(
            "Real skill proof failed at " + stage + "; only sanitized evidence is public",
          );
        } finally {
          await writePublicProof(publicDir, report);
        }
      },
    });
  }, 240000);
  // Sequential cases preserve the candidate receipt before the independent required upgrade.
  it.sequential("proves actual latest-stable copied-state upgrade", async (context) => {
    const report = authorityReport;
    const publicDir = process.env.PROOF_PUBLIC_DIR;
    if (!report || !publicDir || process.env.GITHUB_ACTIONS !== "true") {
      throw new Error("Run both proof cases in the qualified exact-head workflow");
    }
    report.upgradeStatus = "running";
    await writePublicProof(publicDir, report);
    let stage = "stable-package-preparation";
    const progress = (next: string) => {
      context.signal.throwIfAborted();
      stage = next;
      console.info("Stable upgrade proof stage: " + next);
    };
    try {
      await prepareStablePackage();
      await withOpenClawTestState(
        { label: "skills-upgrade-owned-https", applyEnv: false },
        async (raw) => {
          const tls = createLoopbackTlsFixture(raw.root, "DNS:localhost,IP:127.0.0.1,IP:127.0.0.2");
          const trusted = getCACertificates("default");
          const sources: Source[] = [];
          setDefaultCACertificates([...trusted, await fs.readFile(tls.caCert, "utf8")]);
          await runQaGatewayFixture(
            async () => {
              const source = await createProofSource(tls, await createProofArchive());
              sources.push(source);
              report.upgrade = await proveStableSkillUpgrade({
                source,
                caCert: tls.caCert,
                expectedHead: report.source.observedHead,
                signal: context.signal,
                onStage: progress,
              });
            },
            () => sources[0]?.close(),
            () => setDefaultCACertificates(trusted),
          );
        },
      );
      report.upgradeStatus = "passed";
    } catch {
      report.upgradeStatus = "failed";
      report.upgradeFailedStage = stage;
      report.failedStage ??= stage;
      // The command owner emits its safe facts; never chain private preparation exceptions.
      throw new Error(
        "Stable upgrade proof failed at " + stage + "; only sanitized evidence is public",
      );
    } finally {
      await writePublicProof(publicDir, report);
    }
  }, 1200000);
});
