import type { Dispatcher } from "undici";
export type DispatcherAwareRequestInit = RequestInit & {
    dispatcher?: Dispatcher;
};
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export declare function isMockedFetch(fetchImpl: FetchLike | undefined): boolean;
export declare function fetchWithRuntimeDispatcher(input: RequestInfo | URL, init?: DispatcherAwareRequestInit): Promise<Response>;
export declare function fetchWithRuntimeDispatcherOrMockedGlobal(input: RequestInfo | URL, init?: DispatcherAwareRequestInit): Promise<Response>;
export {};
