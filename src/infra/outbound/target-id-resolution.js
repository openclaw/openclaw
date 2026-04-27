import { maybeResolvePluginMessagingTarget } from "./target-normalization.js";
export async function maybeResolveIdLikeTarget(params) {
    const target = await maybeResolvePluginMessagingTarget({
        ...params,
        requireIdLike: true,
    });
    if (!target) {
        return undefined;
    }
    return target;
}
