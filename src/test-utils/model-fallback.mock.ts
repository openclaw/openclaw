export async function runWithModelFallback(params: {
	provider: string;
	model: string;
	run: (
		provider: string,
		model: string,
		options?: { allowTransientCooldownProbe?: boolean },
	) => Promise<unknown>;
}) {
	return {
		result: await params.run(params.provider, params.model),
		provider: params.provider,
		model: params.model,
	};
}
