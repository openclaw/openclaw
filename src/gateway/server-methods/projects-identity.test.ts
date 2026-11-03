import { expect, test, vi } from "vitest";
import * as registry from "../../projects/project-registry.js";
import { projectsHandlers } from "./projects.js";
import { invokeProjectMethod } from "./projects.test-support.js";

test("projects.list projects raw Enterprise origins into read-safe identity without credentials or placement", async () => {
  const cfg = {
    plugins: { entries: { "github-repositories": { config: { host: "ghe.example.test" } } } },
  };
  using _ = vi.spyOn(registry, "listProjectRegistry").mockResolvedValue([
    {
      id: "console",
      displayName: "Console",
      source: "registered",
      repoRoot: "/private/console",
      originUrl: "git@ghe.example.test:Acme/Console.git",
    },
    {
      id: "credentials",
      displayName: "Credentials",
      source: "registered",
      repoRoot: "/private/credentials",
      originUrl: "https://user:placeholder@ghe.example.test/acme/private.git?secret=placeholder",
    },
  ]);
  const invoke = (scopes: string[]) =>
    invokeProjectMethod("projects.list", {}, cfg, scopes, undefined, projectsHandlers);
  const read = await invoke(["operator.sessions.read"]);
  expect(read).toEqual({
    ok: true,
    error: undefined,
    payload: {
      projects: [
        {
          id: "console",
          displayName: "Console",
          source: "registered",
          repositoryIdentity: "acme/console",
        },
        { id: "credentials", displayName: "Credentials", source: "registered" },
      ],
    },
  });
  const write = await invoke(["operator.write"]);
  expect(write).toMatchObject({
    ok: true,
    payload: {
      projects: [
        {
          id: "console",
          repoRoot: "/private/console",
          originUrl: "ghe.example.test:Acme/Console.git",
          repositoryIdentity: "acme/console",
        },
        {
          id: "credentials",
          repoRoot: "/private/credentials",
          originUrl: "https://ghe.example.test/acme/private.git",
        },
      ],
    },
  });
});
