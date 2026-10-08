import { describe, expect, it } from "vitest";
import {
  DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS,
  resolveSandboxConfigForAgent,
} from "../agents/sandbox/config.js";
import type { AgentSandboxConfig } from "./types.agents-shared.js";
import { validateConfigObject } from "./validation.js";

function validateSandbox(kind: "docker" | "browser", value: Record<string, unknown>) {
  return validateConfigObject({ agents: { defaults: { sandbox: { [kind]: value } } } });
}

function resolveSandbox(defaults: AgentSandboxConfig, agent: AgentSandboxConfig = {}) {
  return resolveSandboxConfigForAgent(
    { agents: { defaults: { sandbox: defaults }, entries: { test: { sandbox: agent } } } },
    "test",
  );
}

describe("sandbox docker config", () => {
  it("joins setupCommand arrays with newlines", () => {
    const res = validateSandbox("docker", {
      setupCommand: ["apt-get update", "apt-get install -y curl"],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.agents?.defaults?.sandbox?.docker?.setupCommand).toBe(
        "apt-get update\napt-get install -y curl",
      );
    }
  });

  it("preserves global and per-agent Docker binds", () => {
    const binds = ["/home/user/source:/source:rw", "/var/data/myapp:/data:ro"];
    const agentBinds = ["/home/user/projects:/projects:ro"];
    const res = validateConfigObject({
      agents: {
        defaults: { sandbox: { docker: { binds } } },
        entries: {
          main: { sandbox: { docker: { image: "custom-sandbox:latest", binds: agentBinds } } },
        },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.agents?.defaults?.sandbox?.docker?.binds).toEqual(binds);
      expect(res.config.agents?.entries?.main?.sandbox?.docker?.binds).toEqual(agentBinds);
    }
  });

  it.each(["docker", "browser"] as const)(
    "validates %s bind sources without trimming path bytes",
    (backend) => {
      for (const [bind, accepted] of [
        [" /home/user/source:/data", false],
        ["/home/user/source :/data ", true],
      ] as const) {
        const result = validateSandbox(backend, { binds: [bind] });
        expect(result.ok, bind).toBe(accepted);
        if (result.ok) {
          expect(result.config.agents?.defaults?.sandbox?.[backend]?.binds).toEqual([bind]);
        }
      }
    },
  );

  it.each([
    ["docker", "network", "host"],
    ["docker", "network", "container:peer"],
    ["docker", "seccompProfile", "unconfined"],
    ["docker", "apparmorProfile", "unconfined"],
    ["browser", "network", "host"],
    ["browser", "network", "container:peer"],
  ] as const)("rejects %s %s=%s", (kind, field, value) => {
    expect(validateSandbox(kind, { [field]: value }).ok).toBe(false);
  });

  it.each(["docker", "browser"] as const)(
    "allows %s container namespace join with explicit dangerous override",
    (kind) => {
      const docker = { dangerouslyAllowContainerNamespaceJoin: true };
      const sandbox =
        kind === "docker"
          ? { docker: { ...docker, network: "container:peer" } }
          : { docker, browser: { network: "container:peer" } };
      const res = validateConfigObject({ agents: { defaults: { sandbox } } });
      expect(res.ok).toBe(true);
    },
  );

  it("uses agent override precedence for dangerous sandbox docker booleans", () => {
    for (const key of DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS) {
      const inherited = resolveSandbox({ scope: "agent", docker: { [key]: true } }).docker;
      expect(inherited[key]).toBe(true);

      const overridden = resolveSandbox(
        { scope: "agent", docker: { [key]: true } },
        { docker: { [key]: false } },
      ).docker;
      expect(overridden[key]).toBe(false);

      const sharedScope = resolveSandbox(
        { scope: "shared", docker: { [key]: true } },
        { docker: { [key]: false } },
      ).docker;
      expect(sharedScope[key]).toBe(true);
    }
  });
  it("ignores agent browser binds under shared scope", () => {
    const resolved = resolveSandbox(
      { scope: "shared", browser: { binds: ["/global:/global:ro"] } },
      { browser: { binds: ["/agent:/agent:rw"] } },
    ).browser;
    expect(resolved.binds).toEqual(["/global:/global:ro"]);

    const resolvedNoGlobal = resolveSandbox(
      { scope: "shared", browser: {} },
      { browser: { binds: ["/agent:/agent:rw"] } },
    ).browser;
    expect(resolvedNoGlobal.binds).toBeUndefined();
  });

  it("defaults browser network to dedicated sandbox network", () => {
    const resolved = resolveSandbox({ scope: "agent", browser: {} }).browser;
    expect(resolved.network).toBe("openclaw-sandbox-browser");
  });
});
