/**
 * Suppresses assistant narration when explicit message() tool calls are detected.
 * Prevents "double-reply" artifacts where narration leaks alongside cards.
 * Addresses #54061.
 */
export function shouldSuppressAssistantNarration(inlineText: string, toolCalls: any[]): boolean {
    const hasExplicitSend = toolCalls.some(tc => tc.name === "message" && tc.arguments?.action === "send");
    
    // If an explicit message send is planned, and the narration is non-essential, suppress it.
    if (hasExplicitSend && inlineText.length < 200) {
        return true;
    }
    return false;
}
