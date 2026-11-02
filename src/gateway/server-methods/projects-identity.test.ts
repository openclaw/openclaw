import { expect, test, vi } from "vitest";
import * as registry from "../../projects/project-registry.js";
import { projectsHandlers } from "./projects.js";

test("projects.list projects raw Enterprise origins into read-safe identity without credentials or placement", async () => {
  const cfg = { gateway: { github: { host: "ghe.example.test" } } };
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
  const invoke = async (scopes: string[]) => {
    const respond = vi.fn();
    // SAFETY: fixed registry I/O makes this read consume only the supplied context and client fields.
    await projectsHandlers["projects.list"]!({
      params: {},
      respond,
      context: { getRuntimeConfig: () => cfg },
      client: { connect: { scopes } },
      isWebchatConnect: () => false,
    } as Parameters<NonNullable<(typeof projectsHandlers)["projects.list"]>>[0]);
    const [ok, payload, error] = respond.mock.calls[0]!;
    return { ok, payload, error };
  };
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
