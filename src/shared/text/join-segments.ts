export function concatOptionalTextSegments(params: {
	left?: string;
	right?: string;
	separator?: string;
}): string | undefined {
	const separator = params.separator ?? "\n\n";
	if (params.left && params.right) {
		return `${params.left}${separator}${params.right}`;
	}
	return params.right ?? params.left;
}

export function joinPresentTextSegments(
	segments: ReadonlyArray<string | null | undefined>,
	options?: {
		separator?: string;
		trim?: boolean;
	},
): string | undefined {
	const separator = options?.separator ?? "\n\n";
	const trim = options?.trim ?? false;
	const values: string[] = [];
	for (const segment of segments) {
		if (typeof segment !== "string") {
			continue;
		}
		const normalized = trim ? segment.trim() : segment;
		if (!normalized) {
			continue;
		}
		values.push(normalized);
	}
	return values.length > 0 ? values.join(separator) : undefined;
}
