import { describe, expect, it } from "vitest";
import {
  DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS,
  resolveSandboxConfigForAgent,
} from "../agents/sandbox/config.js";
import type { AgentSandboxConfig } from "./types.agents-shared.js";
import { validateConfigObject } from "./validation.js";

function validateSandbox(sandbox: unknown, agent?: unknown) {
  return validateConfigObject({
    agents: { defaults: { sandbox }, ...(agent ? { entries: { main: { sandbox: agent } } } : {}) },
  });
}

function parsedSandbox(sandbox: unknown, agent?: unknown) {
  const result = validateSandbox(sandbox, agent);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(JSON.stringify(result.issues));
  }
  return result.config.agents;
}

function resolveSandbox(defaults: AgentSandboxConfig, agent: AgentSandboxConfig = {}) {
  return resolveSandboxConfigForAgent(
    { agents: { defaults: { sandbox: defaults }, entries: { test: { sandbox: agent } } } },
    "test",
  );
}

describe("sandbox docker config", () => {
  it("joins setupCommand arrays with newlines", () => {
    const agents = parsedSandbox({
      docker: {
        setupCommand: ["apt-get update", "apt-get install -y curl"],
      },
    });
    expect(agents?.defaults?.sandbox?.docker?.setupCommand).toBe(
      "apt-get update\napt-get install -y curl",
    );
  });

  it("preserves global and per-agent Docker binds", () => {
    const binds = ["/home/user/source:/source:rw", "/var/data/myapp:/data:ro"];
    const agentBinds = ["/home/user/projects:/projects:ro"];
    const agents = parsedSandbox(
      { docker: { binds } },
      { docker: { image: "custom-sandbox:latest", binds: agentBinds } },
    );
    expect(agents?.defaults?.sandbox?.docker?.binds).toEqual(binds);
    expect(agents?.entries?.main?.sandbox?.docker?.binds).toEqual(agentBinds);
  });

  it.each(["docker", "browser"] as const)(
    "validates %s bind sources without trimming path bytes",
    (backend) => {
      for (const [bind, accepted] of [
        [" /home/user/source:/data", false],
        ["/home/user/source :/data ", true],
      ] as const) {
        const result = validateSandbox({ [backend]: { binds: [bind] } });
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
    expect(validateSandbox({ [kind]: { [field]: value } }).ok).toBe(false);
  });

  it.each(["docker", "browser"] as const)(
    "allows %s container namespace join with explicit dangerous override",
    (kind) => {
      const docker = { dangerouslyAllowContainerNamespaceJoin: true };
      const sandbox =
        kind === "docker"
          ? { docker: { ...docker, network: "container:peer" } }
          : { docker, browser: { network: "container:peer" } };
      expect(validateSandbox(sandbox).ok).toBe(true);
    },
  );

  it("uses agent override precedence for dangerous sandbox docker booleans", () => {
    for (const key of DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS) {
      const defaults = { scope: "agent", docker: { [key]: true } } satisfies AgentSandboxConfig;
      const override = { docker: { [key]: false } };
      expect(resolveSandbox(defaults).docker[key]).toBe(true);
      expect(resolveSandbox(defaults, override).docker[key]).toBe(false);
      expect(resolveSandbox({ ...defaults, scope: "shared" }, override).docker[key]).toBe(true);
    }
  });
  it("ignores agent browser binds under shared scope", () => {
    const agent = { browser: { binds: ["/agent:/agent:rw"] } };
    const resolved = resolveSandbox(
      { scope: "shared", browser: { binds: ["/global:/global:ro"] } },
      agent,
    ).browser;
    expect(resolved.binds).toEqual(["/global:/global:ro"]);
    expect(resolved.network).toBe("openclaw-sandbox-browser");

    const resolvedNoGlobal = resolveSandbox({ scope: "shared", browser: {} }, agent).browser;
    expect(resolvedNoGlobal.binds).toBeUndefined();
  });
});
