type MockFactory<TModule extends object> =
  | Partial<TModule>
  | ((actual: TModule) => Partial<TModule>);

function resolveMockOverrides<TModule extends object>(
  actual: TModule,
  factory: MockFactory<TModule>,
): Partial<TModule> {
  return typeof factory === "function" ? factory(actual) : factory;
}

function resolveDefaultBase<TModule extends object>(actual: TModule): Record<string, unknown> {
  const defaultExport = (actual as TModule & { default?: unknown }).default;
  if (defaultExport && typeof defaultExport === "object") {
    return defaultExport as Record<string, unknown>;
  }
  return actual as Record<string, unknown>;
}

export async function mockNodeBuiltinModule<TModule extends object>(
  importOriginal: () => Promise<TModule>,
  factory: MockFactory<TModule>,
  options?: { mirrorToDefault?: boolean },
): Promise<TModule> {
  const actual = await importOriginal();
  const overrides = resolveMockOverrides(actual, factory);
  const mocked = {
    ...actual,
    ...overrides,
  } as TModule & { default?: Record<string, unknown> };

  if (!options?.mirrorToDefault) {
    return mocked;
  }

  return {
    ...mocked,
    default: {
      ...resolveDefaultBase(actual),
      ...overrides,
    },
  } as TModule;
}
