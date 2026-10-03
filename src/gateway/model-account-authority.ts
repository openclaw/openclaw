/** Transaction-local role facts; the host still owns connection and policy authority. */
export type ModelAccountRole = { profileId: string; role: string | null };

/** In-process account authority shared by connect and selection owners; never serialized. */
export type ModelAccountConnectAction = {
  owner: string;
  actorProfileId?: string;
  assertCurrent: (roles?: readonly ModelAccountRole[]) => void;
};

export type UserModelAccountSelection = ModelAccountConnectAction & { authProfileId: string };
