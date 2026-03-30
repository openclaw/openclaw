export async function mergeMockedModule<TModule extends object>(
	actual: TModule,
	buildOverrides: (
		actual: TModule,
	) => Partial<TModule> | Promise<Partial<TModule>>,
) {
	return {
		...actual,
		...(await buildOverrides(actual)),
	};
}
