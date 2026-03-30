import { describe, expect, it, vi } from "vitest";
import {
	emitSessionLifecycleEvent,
	onSessionLifecycleEvent,
} from "./session-lifecycle-events.js";

describe("session lifecycle events", () => {
	it("delivers events to active listeners and stops after unsubscribe", () => {
		const listener = vi.fn();
		const unsubscribe = onSessionLifecycleEvent(listener);

		emitSessionLifecycleEvent({
			sessionKey: "agent:main:main",
			reason: "created",
			label: "Main",
		});
		expect(listener).toHaveBeenCalledTimes(1);
		expect(listener).toHaveBeenCalledWith({
			sessionKey: "agent:main:main",
			reason: "created",
			label: "Main",
		});

		unsubscribe();
		emitSessionLifecycleEvent({
			sessionKey: "agent:main:main",
			reason: "updated",
		});
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("keeps notifying other listeners when one throws", () => {
		const noisy = vi.fn(() => {
			throw new Error("boom");
		});
		const healthy = vi.fn();
		const unsubscribeNoisy = onSessionLifecycleEvent(noisy);
		const unsubscribeHealthy = onSessionLifecycleEvent(healthy);

		expect(() =>
			emitSessionLifecycleEvent({
				sessionKey: "agent:main:main",
				reason: "resumed",
			}),
		).not.toThrow();

		expect(noisy).toHaveBeenCalledTimes(1);
		expect(healthy).toHaveBeenCalledTimes(1);

		unsubscribeNoisy();
		unsubscribeHealthy();
	});
});
