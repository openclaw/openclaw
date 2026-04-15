import fs from "node:fs/promises";
import path from "node:path";

export const PACKAGE_DIST_INVENTORY_RELATIVE_PATH = "dist/postinstall-inventory.json";

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/");
}

async function collectRelativeFiles(rootDir: string, baseDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    const files = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(rootDir, entry.name);
        if (entry.isDirectory()) {
          return await collectRelativeFiles(entryPath, baseDir);
        }
        if (entry.isFile() || entry.isSymbolicLink()) {
          const relativePath = normalizeRelativePath(path.relative(baseDir, entryPath));
          return relativePath === PACKAGE_DIST_INVENTORY_RELATIVE_PATH ? [] : [relativePath];
        }
        return [];
      }),
    );
    return files.flat().toSorted((left, right) => left.localeCompare(right));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function collectPackageDistInventory(packageRoot: string): Promise<string[]> {
  return await collectRelativeFiles(path.join(packageRoot, "dist"), packageRoot);
}

export async function writePackageDistInventory(packageRoot: string): Promise<string[]> {
  const inventory = await collectPackageDistInventory(packageRoot);
  const inventoryPath = path.join(packageRoot, PACKAGE_DIST_INVENTORY_RELATIVE_PATH);
  await fs.mkdir(path.dirname(inventoryPath), { recursive: true });
  await fs.writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
  return inventory;
}

export async function readPackageDistInventory(packageRoot: string): Promise<string[]> {
  const inventoryPath = path.join(packageRoot, PACKAGE_DIST_INVENTORY_RELATIVE_PATH);
  const raw = await fs.readFile(inventoryPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error(`Invalid package dist inventory at ${PACKAGE_DIST_INVENTORY_RELATIVE_PATH}`);
  }
  return [...new Set(parsed.map(normalizeRelativePath))].toSorted((left, right) =>
    left.localeCompare(right),
  );
}

export async function collectPackageDistInventoryErrors(packageRoot: string): Promise<string[]> {
  let expectedFiles: string[];
  try {
    expectedFiles = await readPackageDistInventory(packageRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [`missing package dist inventory ${PACKAGE_DIST_INVENTORY_RELATIVE_PATH}`];
    }
    throw error;
  }

  const actualFiles = await collectPackageDistInventory(packageRoot);
  const expectedSet = new Set(expectedFiles);
  const actualSet = new Set(actualFiles);
  const errors: string[] = [];

  for (const relativePath of expectedFiles) {
    if (!actualSet.has(relativePath)) {
      errors.push(`missing packaged dist file ${relativePath}`);
    }
  }
  for (const relativePath of actualFiles) {
    if (!expectedSet.has(relativePath)) {
      errors.push(`unexpected packaged dist file ${relativePath}`);
    }
  }
  return errors;
}
