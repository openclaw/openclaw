export type CurrentUserProfileDisplay =
  | {
      kind: "resolved";
      profileId: string;
      label?: string;
      avatarUrl: string;
      hasUploadedAvatar: boolean;
    }
  | { kind: "unresolved" };

export type CurrentUserProfileDisplayResolver = (senderId: string) => CurrentUserProfileDisplay;
