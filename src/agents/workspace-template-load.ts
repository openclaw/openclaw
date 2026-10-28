import fs from "node:fs/promises";
import path from "node:path";
import { hasNodeErrorCode } from "@openclaw/fs-safe/path";
import { extractFrontmatterBlock } from "../../packages/markdown-core/src/frontmatter.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import { resolveWorkspaceTemplateSearchDirs } from "./workspace-templates.js";

const workspaceTemplateCache = new Map<string, Promise<string>>();
export class MissingWorkspaceTemplateError extends Error {}

export function loadWorkspaceTemplate(name: string): Promise<string> {
  return getOrCreatePromise(
    workspaceTemplateCache,
    name,
    async () => {
      const templateDirs = await resolveWorkspaceTemplateSearchDirs();
      const triedPaths: string[] = [];
      for (const templateDir of templateDirs) {
        const templatePath = path.join(templateDir, name);
        triedPaths.push(templatePath);
        try {
          const content = await fs.readFile(templatePath, "utf-8");
          return extractFrontmatterBlock(content)?.body.replace(/^\s+/, "") ?? content;
        } catch (error) {
          if (!hasNodeErrorCode(error, "ENOENT")) {
            throw error;
          }
        }
      }
      throw new MissingWorkspaceTemplateError(
        `Missing workspace template: ${name} (${triedPaths.join(", ")}). Check that workspace templates are packaged.`,
      );
    },
    { cacheRejections: false },
  );
}
