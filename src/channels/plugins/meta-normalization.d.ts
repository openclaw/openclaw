import type { ChannelMeta } from "./types.public.js";
export declare function normalizeChannelMeta<TId extends string>(params: {
    id: TId;
    meta?: Partial<ChannelMeta> | null;
    existing?: Partial<ChannelMeta> | null;
}): ChannelMeta & {
    id: TId;
};
