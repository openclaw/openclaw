import { Type, type Static } from "@sinclair/typebox";

export const OnboardingStatusParamsSchema = Type.Object({}, { additionalProperties: false });
export type OnboardingStatusParams = Static<typeof OnboardingStatusParamsSchema>;

export const OnboardingUpdateParamsSchema = Type.Object(
  {
    currentStep: Type.Optional(Type.Number()),
    stepsCompleted: Type.Optional(Type.Array(Type.Number())),
    stepsSkipped: Type.Optional(Type.Array(Type.Number())),
    configSnapshot: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type OnboardingUpdateParams = Static<typeof OnboardingUpdateParamsSchema>;

export const OnboardingCompleteParamsSchema = Type.Object({}, { additionalProperties: false });
export type OnboardingCompleteParams = Static<typeof OnboardingCompleteParamsSchema>;

export const OnboardingSkipParamsSchema = Type.Object({}, { additionalProperties: false });
export type OnboardingSkipParams = Static<typeof OnboardingSkipParamsSchema>;

export const OnboardingResetParamsSchema = Type.Object({}, { additionalProperties: false });
export type OnboardingResetParams = Static<typeof OnboardingResetParamsSchema>;

export const OnboardingValidatePathParamsSchema = Type.Object(
  {
    path: Type.String(),
  },
  { additionalProperties: false },
);
export type OnboardingValidatePathParams = Static<typeof OnboardingValidatePathParamsSchema>;
