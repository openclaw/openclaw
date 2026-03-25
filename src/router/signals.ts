export interface RouterSignals {
  retryCount: number;
  toolCallCount: number;
  contextGrowth: number;
  contextSize: number;
  errors: string[];
}

export class SignalCollector {
  private retryCount = 0;
  private toolCallCount = 0;
  private contextSize = 0;
  private errors: string[] = [];
  private contextGrowth = 0;
  private initialContextSize = 0;

  recordRetry(): void {
    this.retryCount++;
  }

  recordToolCall(): void {
    this.toolCallCount++;
  }

  recordContextSize(size: number): void {
    if (this.initialContextSize === 0) {
      this.initialContextSize = size;
    } else {
      this.contextGrowth = (size - this.initialContextSize) / this.initialContextSize;
    }
    this.contextSize = size;
  }

  recordError(pattern: string): void {
    this.errors.push(pattern);
  }

  getSignals(): RouterSignals {
    return {
      retryCount: this.retryCount,
      toolCallCount: this.toolCallCount,
      contextGrowth: this.contextGrowth,
      contextSize: this.contextSize,
      errors: [...this.errors],
    };
  }
}
