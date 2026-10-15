import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

const dockerEnv = { env: { SYNTHETIC_VALUE: "synthetic-first\nsynthetic-second" } };

describe("sandbox container environment validation", () => {
  it.each([
    { backend: "docker", key: "SYNTHETIC-BAD-NAME", value: "synthetic-private-invalid-name-value" },
    {
      backend: "podman",
      key: "SYNTHETIC_NUL",
      value: "synthetic-private-before\0synthetic-private-after",
    },
  ])("rejects $key without exposing values", ({ backend, key, value }) => {
    const result = validateConfigObject({
      agents: { defaults: { sandbox: { backend, docker: { env: { [key]: value } } } } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toHaveLength(1);
      const issue = result.issues[0]!;
      expect(issue.path).toBe("agents.defaults.sandbox.docker.env." + key);
      for (const hint of [
        key,
        backend === "podman" ? "Podman" : "Docker",
        "portable",
        "single-line",
        "NUL",
        "line-delimited",
        "openclaw doctor",
        "manual remediation",
        "SSH/OpenShell",
        key === "SYNTHETIC-BAD-NAME" ? "Rename key" : "mounted file or custom image",
      ]) {
        expect(issue.message).toContain(hint);
      }
      expect(issue.message).not.toContain("doctor --fix");
      for (const fragment of value.split(/[\r\n\0]/u).filter(Boolean)) {
        expect(issue.message).not.toContain(fragment);
      }
    }
  });

  it("accepts unused Docker defaults when every explicit agent uses a remote backend", () => {
    expect(
      validateConfigObject({
        agents: {
          ownership: "explicit",
          defaults: { sandbox: { backend: "docker", docker: dockerEnv } },
          entries: {
            synthetic_ssh: { sandbox: { backend: "ssh" } },
            synthetic_openshell: { sandbox: { backend: "openshell" } },
          },
        },
      }).ok,
    ).toBe(true);
  });

  it("reports inherited invalid defaults once across container backends", () => {
    const result = validateConfigObject({
      agents: {
        ownership: "explicit",
        defaults: { sandbox: { backend: "ssh", docker: dockerEnv } },
        entries: {
          synthetic_docker: { sandbox: { backend: "docker" } },
          synthetic_podman: { sandbox: { backend: "podman" } },
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]?.path).toBe("agents.defaults.sandbox.docker.env.SYNTHETIC_VALUE");
    }
  });

  it.each(["podman"])("attributes agent-owned %s values to their config path", (backend) => {
    const config = {
      agents: {
        defaults: { sandbox: { backend: "ssh" } },
        entries: { synthetic_agent: { sandbox: { backend, docker: dockerEnv } } },
      },
    };
    const result = validateConfigObject(config, { sourceRaw: config });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        expect.objectContaining({
          path: "agents.entries.synthetic_agent.sandbox.docker.env.SYNTHETIC_VALUE",
        }),
      ]);
    }
  });

  it("ignores agent environment overrides in shared scope", () => {
    expect(
      validateConfigObject({
        agents: {
          defaults: {
            sandbox: {
              scope: "shared",
              docker: { env: { SYNTHETIC_SHARED: "synthetic-single-line" } },
            },
          },
          entries: { synthetic_agent: { sandbox: { docker: dockerEnv } } },
        },
      }).ok,
    ).toBe(true);
  });
});
