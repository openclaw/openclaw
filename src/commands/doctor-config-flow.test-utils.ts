const DOCTOR_CONFIG_TEST_INPUT = Symbol.for("openclaw.doctorConfigFlow.testInput");

type DoctorConfigTestInput = {
  config: Record<string, unknown>;
  exists: boolean;
  path: string;
};

function setDoctorConfigInputForTest(input: DoctorConfigTestInput | null): void {
  const globalState = globalThis as typeof globalThis & {
    [DOCTOR_CONFIG_TEST_INPUT]?: DoctorConfigTestInput;
  };
  if (input) {
    globalState[DOCTOR_CONFIG_TEST_INPUT] = input;
    return;
  }
  delete globalState[DOCTOR_CONFIG_TEST_INPUT];
}

export function getDoctorConfigInputForTest(): DoctorConfigTestInput | null {
  const globalState = globalThis as typeof globalThis & {
    [DOCTOR_CONFIG_TEST_INPUT]?: DoctorConfigTestInput;
  };
  return globalState[DOCTOR_CONFIG_TEST_INPUT] ?? null;
}

export async function runDoctorConfigWithInput<T>(params: {
  config: Record<string, unknown>;
  repair?: boolean;
  run: (args: {
    options: { nonInteractive: boolean; repair?: boolean };
    confirm: () => Promise<boolean>;
  }) => Promise<T>;
}) {
  setDoctorConfigInputForTest({
    config: structuredClone(params.config),
    exists: true,
    path: "/virtual/.openclaw/openclaw.json",
  });
  try {
    return await params.run({
      options: { nonInteractive: true, repair: params.repair },
      confirm: async () => false,
    });
  } finally {
    setDoctorConfigInputForTest(null);
  }
}
