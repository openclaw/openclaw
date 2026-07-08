export type ChannelLoginMethod = {
  kind: "phone-number";
  phoneNumber: string;
};

export type ChannelLoginMethodKind = ChannelLoginMethod["kind"];
