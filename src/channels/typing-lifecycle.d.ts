type AsyncTick = () => Promise<void> | void;
export type TypingKeepaliveLoop = {
    tick: () => Promise<void>;
    start: () => void;
    stop: () => void;
    isRunning: () => boolean;
};
export declare function createTypingKeepaliveLoop(params: {
    intervalMs: number;
    onTick: AsyncTick;
}): TypingKeepaliveLoop;
export {};
