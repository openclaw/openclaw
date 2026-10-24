import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  notifyPublications,
  recordPublication,
} from "../../scripts/gateway-publication-notify.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const digest = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
const sourceCommit = "a".repeat(40);
const token = "synthetic-notification-token";
const publication = (name = "openclaw", version = "2026.9.9") => ({
  schema_version: 1,
  package_name: name,
  package_version: version,
  package_integrity: digest,
  source_repository: "openclaw/openclaw",
  source_commit: sourceCommit,
});
const registry = (value = publication()) =>
  Response.json({
    name: value.package_name,
    version: value.package_version,
    dist: { integrity: value.package_integrity },
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("gateway publication notification", () => {
  it("records each tarball's own version and bytes with the release source", async () => {
    const root = tempDirs.make("gateway-publication-");
    mkdirSync(join(root, "package"));
    const output = join(root, "outputs");
    for (const [name, version, key] of [
      ["openclaw", "2026.9.9", "openclaw_publication"],
      ["@openclaw/gateway-protocol", "2026.9.8-beta.1", "gateway_protocol_publication"],
    ]) {
      writeFileSync(join(root, "package", "package.json"), JSON.stringify({ name, version }));
      const archive = join(root, `${key}.tgz`);
      await tar.c({ cwd: root, file: archive, gzip: true }, ["package"]);
      await recordPublication(name, archive, sourceCommit, output);
      const line = readFileSync(output, "utf8").trim().split("\n").at(-1)!;
      expect(line.slice(0, line.indexOf("="))).toBe(key);
      expect(JSON.parse(line.slice(line.indexOf("=") + 1))).toEqual({
        ...publication(name, version),
        package_integrity: `sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}`,
      });
    }
  });

  it("sends both exact package identities only to the fixed receiver", async () => {
    const values = [publication(), publication("@openclaw/gateway-protocol", "2026.9.8-beta.1")];
    const fetchMock = vi.fn<typeof fetch>();
    for (const value of values) {
      fetchMock
        .mockResolvedValueOnce(registry(value))
        .mockResolvedValueOnce(new Response(null, { status: 204 }));
    }
    vi.stubGlobal("fetch", fetchMock);
    await notifyPublications(values, token);
    for (const [index, value] of values.entries()) {
      const [url, request] = fetchMock.mock.calls[index * 2 + 1]!;
      expect(url).toBe("https://api.github.com/repos/openclaw/openclaw-windows-node/dispatches");
      expect(request).toMatchObject({
        method: "POST",
        redirect: "error",
        headers: { Authorization: "Bearer " + token },
      });
      if (typeof request?.body !== "string") {
        throw new Error("Expected serialized dispatch");
      }
      expect(JSON.parse(request.body)).toEqual({
        event_type: "gateway-protocol-published",
        client_payload: value,
      });
      expect(fetchMock.mock.calls[index * 2]?.[1]?.headers).toBeUndefined();
    }
  });

  it.each(["invalid identity", "missing auth"])("rejects %s before I/O", async (fault) => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const value =
      fault === "invalid identity"
        ? { ...publication(), package_name: "unrelated" }
        : publication();
    await expect(
      notifyPublications([value], fault === "missing auth" ? "" : token),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { name: "@openclaw/gateway-protocol", version: "2026.9.9", dist: { integrity: digest } },
    { name: "openclaw", version: "2026.9.10", dist: { integrity: digest } },
    { name: "openclaw", version: "2026.9.9", dist: { integrity: "sha512-wrong" } },
  ])("refuses inconsistent registry readback: %j", async (metadata) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(metadata));
    vi.stubGlobal("fetch", fetchMock);
    await expect(notifyPublications([publication()], token)).rejects.toThrow("differs");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["rejected", "ambiguous", "summary"])(
    "attempts both packages without retrying after %s failure",
    async (fault) => {
      const protocol = publication("@openclaw/gateway-protocol", "2026.9.8");
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(registry());
      if (fault === "ambiguous") {
        fetchMock.mockRejectedValueOnce(new Error(token));
      } else {
        fetchMock.mockResolvedValueOnce(
          new Response(null, { status: fault === "rejected" ? 403 : 204 }),
        );
      }
      fetchMock
        .mockResolvedValueOnce(registry(protocol))
        .mockResolvedValueOnce(new Response(null, { status: 204 }));
      vi.stubGlobal("fetch", fetchMock);
      const root = tempDirs.make("gateway-notification-");
      const summary = fault === "summary" ? root : join(root, "summary");
      const message = {
        rejected: "HTTP 403",
        ambiguous: "unconfirmed",
        summary: "Could not write",
      }[fault];
      await expect(notifyPublications([publication(), protocol], token, summary)).rejects.toThrow(
        message,
      );
      expect(fetchMock).toHaveBeenCalledTimes(4);
      if (fault !== "summary") {
        const evidence = readFileSync(summary, "utf8");
        expect(evidence).toContain("accepted by GitHub");
        expect(evidence).not.toContain(token);
      }
    },
  );
});

const workflow = parse(readFileSync(".github/workflows/openclaw-npm-release.yml", "utf8")) as {
  jobs: { publish_openclaw_npm: { steps: { id?: string; run?: string }[] } };
};

it.each(["record", "summary", "core", "protocol"])(
  "preserves publication after %s failure",
  (fault) => {
    const root = tempDirs.make("gateway-publication-workflow-");
    mkdirSync(join(root, "preflight-tarball"));
    writeFileSync(join(root, "preflight-tarball/protocol.tgz"), "");
    const script = workflow.jobs.publish_openclaw_npm.steps.find(
      (step) => step.id === "publish",
    )?.run;
    expect(script).toBeTruthy();
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        `
    npm() { return 1; }
    git() { printf '%040d\n' 0; }
    jq() { printf '@openclaw/gateway-protocol\tprotocol.tgz\n'; }
    node() {
      if [[ "$1" == "-p" ]]; then echo 2026.9.9; return 0; fi
      echo "record:$3"
      [[ "$FAULT" != record && "$FAULT" != summary ]]
    }
    bash() {
      case "$3" in *protocol.tgz) name=protocol ;; *) name=core ;; esac
      echo "publish:$name"
      [[ "$FAULT" != "$name" ]]
    }
    ${script}
  `,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          FAULT: fault,
          PUBLISH_TARBALL_PATH: "preflight-tarball/core.tgz",
          GITHUB_STEP_SUMMARY: fault === "summary" ? "preflight-tarball" : "summary",
        },
      },
    );
    expect(result.status, result.stderr).toBe(fault === "core" || fault === "protocol" ? 1 : 0);
    const expected =
      fault === "protocol"
        ? ["publish:protocol"]
        : [
            "publish:protocol",
            "record:@openclaw/gateway-protocol",
            "publish:core",
            ...(fault === "core" ? [] : ["record:openclaw"]),
          ];
    expect(result.stdout.split("\n").filter((line) => /^(publish|record):/u.test(line))).toEqual(
      expected,
    );
    if (fault === "record" || fault === "summary") {
      expect(result.stdout).toContain("::warning::");
    }
  },
);
