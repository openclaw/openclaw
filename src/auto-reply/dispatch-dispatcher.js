export async function withReplyDispatcher(params) {
    try {
        return await params.run();
    }
    finally {
        // Ensure dispatcher reservations are always released on every exit path.
        params.dispatcher.markComplete();
        try {
            await params.dispatcher.waitForIdle();
        }
        finally {
            await params.onSettled?.();
        }
    }
}
