import type {
  UsersBackgroundRemoveParams,
  UsersBackgroundResult,
} from "../../packages/gateway-protocol/src/schema/users-background.js";

export type UserBackgroundReadCommand =
  | { type: "userBackground.snapshot"; profileId: string }
  | { type: "userBackground.image"; profileId: string; assetId: string; includeBytes: boolean };
export type UserBackgroundReadReply =
  | {
      type: "userBackground.snapshot";
      profileId: string | undefined;
      result: UsersBackgroundResult;
    }
  | { type: "userBackground.image"; image: Uint8Array | undefined; byteLength: number | undefined };
export type UserBackgroundWriteInput = {
  profileId: string;
  expected: UsersBackgroundRemoveParams;
  image?: { image: Uint8Array; width: number; height: number };
};
