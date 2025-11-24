import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	assertProvider,
	ensureDir,
	normalizeE164,
	normalizePath,
	sleep,
	toWhatsappJid,
	withWhatsAppPrefix,
} from "./utils.js";

describe("normalizePath", () => {
	it("adds leading slash when missing", () => {
		expect(normalizePath("foo")).toBe("/foo");
	});

	it("keeps existing slash", () => {
		expect(normalizePath("/bar")).toBe("/bar");
	});
});

describe("withWhatsAppPrefix", () => {
	it("adds whatsapp prefix", () => {
		expect(withWhatsAppPrefix("+1555")).toBe("whatsapp:+1555");
	});

	it("leaves prefixed intact", () => {
		expect(withWhatsAppPrefix("whatsapp:+1555")).toBe("whatsapp:+1555");
	});
});

describe("ensureDir", () => {
	it("creates nested directory", async () => {
		const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "warelay-test-"));
		const target = path.join(tmp, "nested", "dir");
		await ensureDir(target);
		expect(fs.existsSync(target)).toBe(true);
	});
});

describe("sleep", () => {
	it("resolves after delay using fake timers", async () => {
		vi.useFakeTimers();
		const promise = sleep(1000);
		vi.advanceTimersByTime(1000);
		await expect(promise).resolves.toBeUndefined();
		vi.useRealTimers();
	});
});

describe("assertProvider", () => {
	it("throws for invalid provider", () => {
		expect(() => assertProvider("bad" as string)).toThrow();
	});
});

describe("normalizeE164 & toWhatsappJid", () => {
	it("strips formatting and prefixes", () => {
		expect(normalizeE164("whatsapp:(555) 123-4567")).toBe("+5551234567");
		expect(toWhatsappJid("whatsapp:+555 123 4567")).toBe("5551234567@s.whatsapp.net");
	});
});
