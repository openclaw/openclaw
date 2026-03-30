export type ScopedExpiringIdCache<
	TScope extends string | number,
	TId extends string | number,
> = {
	record: (scope: TScope, id: TId, now?: number) => void;
	has: (scope: TScope, id: TId, now?: number) => boolean;
	clear: () => void;
};

export function createScopedExpiringIdCache<
	TScope extends string | number,
	TId extends string | number,
>(options: {
	store: Map<string, Map<string, number>>;
	ttlMs: number;
	cleanupThreshold: number;
}): ScopedExpiringIdCache<TScope, TId> {
	const ttlMs = Math.max(0, options.ttlMs);
	const cleanupThreshold = Math.max(1, Math.floor(options.cleanupThreshold));

	function cleanupExpired(
		scopeKey: string,
		entry: Map<string, number>,
		now: number,
	): void {
		for (const [id, timestamp] of entry) {
			if (now - timestamp > ttlMs) {
				entry.delete(id);
			}
		}
		if (entry.size === 0) {
			options.store.delete(scopeKey);
		}
	}

	return {
		record: (scope, id, now = Date.now()) => {
			const scopeKey = String(scope);
			const idKey = String(id);
			let entry = options.store.get(scopeKey);
			if (!entry) {
				entry = new Map<string, number>();
				options.store.set(scopeKey, entry);
			}
			entry.set(idKey, now);
			if (entry.size > cleanupThreshold) {
				cleanupExpired(scopeKey, entry, now);
			}
		},
		has: (scope, id, now = Date.now()) => {
			const scopeKey = String(scope);
			const idKey = String(id);
			const entry = options.store.get(scopeKey);
			if (!entry) {
				return false;
			}
			cleanupExpired(scopeKey, entry, now);
			return entry.has(idKey);
		},
		clear: () => {
			options.store.clear();
		},
	};
}
