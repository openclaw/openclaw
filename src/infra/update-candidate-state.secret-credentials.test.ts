import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runUpdateCandidateSnapshotWorker } from "./update-candidate-state.test-support.js";

/**
 * Boot-time exec SecretRefs are resolved by the candidate Gateway against the rehearsal
 * state root, so provider prerequisites under `<state dir>/credentials` have to travel
 * with the private copy (issue #192066).
 */
describe("snapshot secret provider credentials", () => {
  let root: string;
  let source: string;
  let target: string;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "candidate-secret-")));
    source = path.join(root, "source");
    target = path.join(root, "copy");
    await fs.mkdir(source, { recursive: true });
    await fs.mkdir(target, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function writeCredential(relative: string, contents: string, mode = 0o600) {
    const file = path.join(source, relative);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, contents, { mode });
    return file;
  }

  async function snapshot(config: Record<string, unknown>) {
    return runUpdateCandidateSnapshotWorker({
      stateDir: source,
      targetStateDir: target,
      candidateRoot: path.join(root, "candidate-host"),
      config,
      env: { OPENCLAW_STATE_DIR: source },
    });
  }

  it("projects the bundled 1Password token required by an exec plugin integration", async () => {
    const token = "ops_example_service_account_token";
    const tokenFile = await writeCredential(
      path.join("credentials", "onepassword", "service-account-token"),
      token,
    );
    // A channel credential no configured provider names stays out of the copy.
    const unrelated = await writeCredential(
      path.join("credentials", "slack", "oauth.json"),
      '{"token":"xoxb-unrelated"}',
    );
    await snapshot({
      secrets: {
        providers: {
          onepassword: {
            source: "exec",
            pluginIntegration: { pluginId: "onepassword", integrationId: "onepassword" },
          },
        },
      },
    });
    const copied = path.join(target, "credentials", "onepassword", "service-account-token");
    expect(await fs.readFile(copied, "utf8")).toBe(token);
    expect((await fs.stat(copied)).mode & 0o777).toBe(0o600);
    expect(
      await fs.stat(path.join(target, "credentials", "slack", "oauth.json")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    // The serving installation keeps its own credentials untouched.
    expect(await fs.readFile(tokenFile, "utf8")).toBe(token);
    expect(await fs.readFile(unrelated, "utf8")).toBe('{"token":"xoxb-unrelated"}');
  });

  it("does not copy a plugin directory that a manual exec provider only aliases", async () => {
    // A custom resolver whose config alias happens to equal a plugin's directory name
    // does not own that material; the alias is not an ownership signal (issue #192066 review).
    const aliased = await writeCredential(
      path.join("credentials", "onepassword", "service-account-token"),
      "ops_belongs_to_the_plugin_tool",
    );
    await snapshot({
      secrets: {
        providers: {
          onepassword: { source: "exec", command: "/usr/local/bin/env-resolver" },
        },
      },
    });
    expect(
      await fs.lstat(path.join(target, "credentials")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(await fs.readFile(aliased, "utf8")).toBe("ops_belongs_to_the_plugin_tool");
  });

  it("keeps the required credential when an owned directory holds unrelated bulk", async () => {
    // A configured plugin integration whose directory also holds unrelated bulk must neither
    // lose the resolver prerequisite nor turn a working installation into a blocked update
    // (issue #192066 review).
    await writeCredential(path.join("credentials", "onepassword", "service-account-token"), "tok");
    for (let index = 0; index < 200; index += 1) {
      await writeCredential(
        path.join("credentials", "onepassword", "unrelated", `noise-${index}.bin`),
        "x",
      );
    }
    await snapshot({
      secrets: {
        providers: {
          onepassword: {
            source: "exec",
            pluginIntegration: { pluginId: "onepassword", integrationId: "onepassword" },
          },
        },
      },
    });
    // The prerequisite the resolver reads survives the unrelated bulk below it.
    const copied = path.join(target, "credentials", "onepassword", "service-account-token");
    expect(await fs.readFile(copied, "utf8")).toBe("tok");
    expect((await fs.stat(copied)).mode & 0o777).toBe(0o600);
    expect(
      await fs.readFile(
        path.join(source, "credentials", "onepassword", "service-account-token"),
        "utf8",
      ),
    ).toBe("tok");
  });

  it("does not copy a credential directory named only by integrationId", async () => {
    // integrationId is a key inside the plugin's manifest, not a credential owner: an unused
    // provider declaring another owner's integration id must not widen the copy
    // (issue #192066 review).
    const token = "ops_example_service_account_token";
    await writeCredential(path.join("credentials", "onepassword", "service-account-token"), token);
    const unrelated = await writeCredential(
      path.join("credentials", "slack", "oauth.json"),
      '{"token":"xoxb-unrelated"}',
    );
    await snapshot({
      secrets: {
        providers: {
          unused: {
            source: "exec",
            pluginIntegration: { pluginId: "onepassword", integrationId: "slack" },
          },
        },
      },
    });
    expect(
      await fs.readFile(path.join(target, "credentials", "onepassword", "service-account-token")),
    ).toEqual(Buffer.from(token));
    expect(
      await fs.lstat(path.join(target, "credentials", "slack")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(await fs.readFile(unrelated, "utf8")).toBe('{"token":"xoxb-unrelated"}');
  });

  it("refuses to follow a credential symlink out of the source state directory", async () => {
    const outside = path.join(root, "outside-token");
    await fs.writeFile(outside, "outside-secret", { mode: 0o600 });
    await fs.mkdir(path.join(source, "credentials", "onepassword"), { recursive: true });
    await fs.symlink(
      outside,
      path.join(source, "credentials", "onepassword", "service-account-token"),
    );
    await snapshot({
      secrets: {
        providers: {
          onepassword: {
            source: "exec",
            pluginIntegration: { pluginId: "onepassword", integrationId: "onepassword" },
          },
        },
      },
    });
    expect(
      await fs.lstat(path.join(target, "credentials", "onepassword", "service-account-token")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(await fs.readFile(outside, "utf8")).toBe("outside-secret");
  });

  it("leaves a hardlinked credential out of the copy without failing the snapshot", async () => {
    const tokenFile = await writeCredential(
      path.join("credentials", "onepassword", "service-account-token"),
      "tok",
    );
    await fs.link(tokenFile, path.join(source, "credentials", "onepassword", "token-alias"));
    await snapshot({
      secrets: {
        providers: {
          onepassword: {
            source: "exec",
            pluginIntegration: { pluginId: "onepassword", integrationId: "onepassword" },
          },
        },
      },
    });
    expect(
      await fs.lstat(path.join(target, "credentials")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(await fs.readFile(tokenFile, "utf8")).toBe("tok");
  });

  it("ignores a plugin identity that is not a single credential directory name", async () => {
    const outside = path.join(root, "outside");
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "token"), "outside-secret", { mode: 0o600 });
    await writeCredential(path.join("credentials", "onepassword", "service-account-token"), "tok");
    await snapshot({
      secrets: {
        providers: {
          evil: {
            source: "exec",
            pluginIntegration: { pluginId: "../../outside", integrationId: "../../outside" },
          },
        },
      },
    });
    expect(
      await fs.lstat(path.join(target, "credentials")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(await fs.readFile(path.join(outside, "token"), "utf8")).toBe("outside-secret");
  });

  it("copies nothing when no SecretRef provider needs state-relative credentials", async () => {
    await writeCredential(path.join("credentials", "onepassword", "service-account-token"), "tok");
    await snapshot({ secrets: { providers: { env: { source: "env", allowlist: ["TOKEN"] } } } });
    expect(
      await fs.lstat(path.join(target, "credentials")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });
});
