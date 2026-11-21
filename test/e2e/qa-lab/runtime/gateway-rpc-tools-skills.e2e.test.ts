import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { withRpcGateway } from "./gateway-rpc.test-support.js";

const SKILL_CARD = "# Catalog Proof\n\nLocal Gateway skill-card evidence.\n";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it(
  "returns built-in commands, core tools, and a readable workspace skill card",
  { timeout: 30_000 },
  async () => {
    await withRpcGateway(
      tempDirs.make("openclaw-rpc-tools-skills-"),
      {
        name: "rpc-tools-skills",
        skipProviders: true,
        setup: async (workspace) => {
          const dir = path.join(workspace, "skills", "catalog-proof");
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(
            path.join(dir, "SKILL.md"),
            "---\nname: catalog-proof\ndescription: Fixture skill for Gateway catalog proof.\n---\n",
            "utf8",
          );
          await fs.writeFile(path.join(dir, "skill-card.md"), SKILL_CARD, "utf8");
        },
      },
      async (client, workspace) => {
        const commands = await client.request<{
          commands: Array<{ name: string; source: string }>;
        }>("commands.list", {});
        expect(commands.commands).toEqual(
          expect.arrayContaining([expect.objectContaining({ name: "model", source: "native" })]),
        );
        const tools = await client.request<{
          groups: Array<{ source: string; tools: Array<{ id: string; source: string }> }>;
        }>("tools.catalog", { includePlugins: false });
        expect(tools.groups.flatMap((group) => group.tools)).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: "tts", source: "core" })]),
        );
        expect(tools.groups.some((group) => group.source === "plugin")).toBe(false);

        const status = await client.request<{
          workspaceDir: string;
          skills: Array<{
            name: string;
            skillKey: string;
            skillCard?: { path: string; present: boolean; sizeBytes: number };
          }>;
        }>("skills.status", {});
        const cardMetadata = {
          path: path.join(workspace, "skills", "catalog-proof", "skill-card.md"),
          sizeBytes: Buffer.byteLength(SKILL_CARD),
        };
        expect(status.workspaceDir).toBe(workspace);
        expect(status.skills.find((skill) => skill.name === "catalog-proof")).toEqual(
          expect.objectContaining({
            name: "catalog-proof",
            skillKey: "catalog-proof",
            skillCard: { ...cardMetadata, present: true },
          }),
        );
        expect(await client.request("skills.skillCard", { skillKey: "catalog-proof" })).toEqual({
          schema: "openclaw.skills.skill-card.v1",
          skillKey: "catalog-proof",
          ...cardMetadata,
          content: SKILL_CARD,
        });
      },
    );
  },
);
