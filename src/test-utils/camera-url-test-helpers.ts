import * as fs from "node:fs/promises";
import { vi } from "vitest";

export function stubFetchResponse(response: Response) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => response),
	);
}

export function stubFetchTextResponse(text: string, init?: ResponseInit) {
	stubFetchResponse(new Response(text, { status: 200, ...init }));
}

export async function readFileUtf8AndCleanup(
	filePath: string,
): Promise<string> {
	try {
		return await fs.readFile(filePath, "utf8");
	} finally {
		await fs.unlink(filePath).catch(() => {});
	}
}
