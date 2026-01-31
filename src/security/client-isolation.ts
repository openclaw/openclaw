import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const BASE_DATA_DIR = process.env.DATA_DIR || "./data";

export function getClientDataPath(clientId: string): string {
  const safeClientId = clientId.replace(/[^a-zA-Z0-9-_]/g, "_");
  return path.join(BASE_DATA_DIR, "clients", safeClientId);
}

export async function ensureClientDirectory(clientId: string): Promise<string> {
  const clientPath = getClientDataPath(clientId);
  await fs.mkdir(clientPath, { recursive: true });
  return clientPath;
}

export async function readClientData(clientId: string, filename: string): Promise<unknown> {
  const filePath = path.join(getClientDataPath(clientId), filename);
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content);
}

export async function writeClientData(clientId: string, filename: string, data: unknown): Promise<void> {
  await ensureClientDirectory(clientId);
  const filePath = path.join(getClientDataPath(clientId), filename);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

export async function deleteClientData(clientId: string): Promise<void> {
  const clientPath = getClientDataPath(clientId);
  await fs.rm(clientPath, { recursive: true, force: true });
}

export async function testClientIsolation(): Promise<boolean> {
  const testClient1 = "test-client-1-" + crypto.randomBytes(4).toString("hex");
  const testClient2 = "test-client-2-" + crypto.randomBytes(4).toString("hex");
  
  try {
    await writeClientData(testClient1, "test.json", { secret: "client1-data" });
    await writeClientData(testClient2, "test.json", { secret: "client2-data" });
    
    const data1 = await readClientData(testClient1, "test.json") as { secret: string };
    const data2 = await readClientData(testClient2, "test.json") as { secret: string };
    
    const isolated = data1.secret === "client1-data" && data2.secret === "client2-data";
    
    await deleteClientData(testClient1);
    await deleteClientData(testClient2);
    
    return isolated;
  } catch {
    return false;
  }
}
