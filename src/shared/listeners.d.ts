export declare function notifyListeners<T>(listeners: Iterable<(event: T) => void>, event: T, onError?: (error: unknown) => void): void;
export declare function registerListener<T>(listeners: Set<(event: T) => void>, listener: (event: T) => void): () => void;
